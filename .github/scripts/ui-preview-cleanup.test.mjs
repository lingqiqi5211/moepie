import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const source = (await fs.readFile(new URL('../ui-preview/publish.mjs', import.meta.url), 'utf8'))
  .replace(/^import .*;\n/gm, '').split('const cmd = process.argv[2];')[0];
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// Real local Git repositories exercise the lease and orphan history; only
// GitHub HTTP and the remote URL are replaced. No network or user files.
async function fixture(t, { absent = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'preview-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const remote = path.join(root, 'remote.git'), seed = path.join(root, 'seed');
  git(root, 'init', '--bare', remote);
  git(root, 'init', seed);
  git(seed, 'config', 'user.name', 'test');
  git(seed, 'config', 'user.email', 'test@example.invalid');
  for (const f of ['index.html', '.nojekyll', 'pr-1/old/shot.png', 'pr-2/old/shot.png', 'pr-101/old/shot.png']) {
    await fs.mkdir(path.dirname(path.join(seed, f)), { recursive: true });
    await fs.writeFile(path.join(seed, f), f);
  }
  git(seed, 'add', '-A');
  git(seed, 'commit', '-qm', 'seed');
  if (!absent) git(seed, 'push', remote, 'HEAD:refs/heads/ui-previews');
  const head = () => git(remote, 'rev-parse', 'refs/heads/ui-previews');
  const files = () => git(remote, 'ls-tree', '-r', '--name-only', 'refs/heads/ui-previews').split('\n');
  const requests = [], commands = [];
  let open = [1, 101], failPage = 0, failGit = '', beforePush;
  const api = runInNewContext(source + '\n({pushMedia})', {
    fs, os, path, console, process: { env: { GITHUB_REPOSITORY: 'owner/repo', GITHUB_TOKEN: 'test-secret', PR: '1' } },
    setTimeout: (fn) => fn(),
    fetch: async (url) => {
      requests.push(url);
      const page = Number(new URL(url).searchParams.get('page'));
      if (page === failPage) return { ok: false, status: 503, text: async () => 'unavailable' };
      return { ok: true, status: 200, json: async () => open.slice((page - 1) * 100, page * 100).map((number) => ({ number })) };
    },
    execFileSync: (cmd, args, opts) => {
      assert.equal(cmd, 'git');
      commands.push([...args]);
      if (args[0] === failGit) throw Object.assign(new Error('failed test-secret'), { status: 128 });
      if (args[0] === 'push' && beforePush) { const f = beforePush; beforePush = null; f(); }
      return execFileSync(cmd, args.map((a) => a.startsWith('https://x-access-token:') ? remote : a), opts);
    },
  });
  return { ...api, root, remote, seed, head, files, requests, commands,
    setOpen: (v) => { open = v; }, failPage: (v) => { failPage = v; }, failGit: (v) => { failGit = v; },
    beforePush: (f) => { beforePush = f; },
    recording: async () => {
      const dir = path.join(root, 'recording');
      await fs.mkdir(dir);
      await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ scenes: [], video: 'clip.mp4' }));
      await fs.writeFile(path.join(dir, 'clip.mp4'), 'recording');
      return dir;
    },
  };
}

test('cleanup preserves open PRs across all pages and is idempotent', async (t) => {
  const f = await fixture(t);
  f.setOpen([1, ...Array.from({ length: 99 }, (_, i) => i + 200), 101]);
  await f.pushMedia();
  assert.deepEqual(f.files(), ['.nojekyll', 'index.html', 'pr-1/old/shot.png', 'pr-101/old/shot.png']);
  assert.equal(git(f.remote, 'rev-list', '--count', 'ui-previews'), '1');
  assert.ok(f.requests.some((u) => u.endsWith('page=2')));
  const head = f.head();
  assert.equal(await f.pushMedia(), false);
  assert.equal(f.head(), head);
});

test('a failed later API page never deletes or pushes', async (t) => {
  const f = await fixture(t);
  f.setOpen(Array.from({ length: 100 }, (_, i) => i + 1));
  f.failPage(2);
  const head = f.head();
  await assert.rejects(f.pushMedia(), /503/);
  assert.equal(f.head(), head);
  assert.ok(!f.commands.some((c) => c[0] === 'push'));
});

for (const command of ['ls-remote', 'fetch']) {
  test(`a failed ${command} never replaces the branch and hides credentials`, async (t) => {
    const f = await fixture(t);
    const head = f.head();
    f.failGit(command);
    await assert.rejects(f.pushMedia(), (e) => !e.message.includes('test-secret') && e.message.includes('[redacted]'));
    assert.equal(f.head(), head);
    assert.ok(!f.commands.some((c) => c[0] === 'push'));
  });
}

test('missing branch cleanup is a no-op; first publication can create it', async (t) => {
  const f = await fixture(t, { absent: true });
  assert.equal(await f.pushMedia(), false);
  assert.equal(git(f.remote, 'for-each-ref'), '');
  assert.equal(await f.pushMedia('abcdef123', await f.recording()), true);
  assert.ok(f.files().includes('pr-1/abcdef1/clip.mp4'));
});

test('publication replaces its old preview and never resurrects a closed PR', async (t) => {
  const f = await fixture(t), dir = await f.recording();
  await f.pushMedia('abcdef123', dir);
  assert.ok(!f.files().some((p) => p.startsWith('pr-1/old/') || p.startsWith('pr-2/')));
  assert.ok(f.files().includes('pr-101/old/shot.png'));
  f.setOpen([101]);
  await f.pushMedia();
  const head = f.head();
  assert.equal(await f.pushMedia('abcdef123', dir), false);
  assert.equal(f.head(), head);
});

test('lost lease rereads the latest branch and keeps the other writer preview', async (t) => {
  const f = await fixture(t);
  f.setOpen([1, 101, 300]);
  await fs.mkdir(path.join(f.seed, 'pr-300/new'), { recursive: true });
  await fs.writeFile(path.join(f.seed, 'pr-300/new/shot.png'), 'new');
  git(f.seed, 'add', '-A');
  git(f.seed, 'commit', '-qm', 'other preview');
  f.beforePush(() => git(f.seed, 'push', f.remote, 'HEAD:refs/heads/ui-previews'));
  await f.pushMedia();
  assert.ok(f.files().includes('pr-300/new/shot.png'));
  assert.ok(!f.files().some((p) => p.startsWith('pr-2/')));
  assert.equal(git(f.remote, 'rev-list', '--count', 'ui-previews'), '1');
  assert.equal(f.commands.filter((c) => c[0] === 'push').length, 2);
});
