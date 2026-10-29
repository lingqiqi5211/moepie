import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const sha = 'a'.repeat(40);
const other = 'b'.repeat(40);
const assets = [
  ...['arm64', 'amd64'].flatMap((a) => [`moepie-darwin-${a}.dmg`, `moepie-darwin-${a}.zip`]),
  ...['darwin-arm64', 'darwin-amd64', 'linux-amd64', 'linux-arm64', 'android-arm64'].map((p) => `moepie-cli-${p}`),
  ...['amd64', 'arm64'].flatMap((a) => [`moepie-cli-windows-${a}.exe`, `moepie-windows-${a}.exe`, `moepie-linux-${a}`]),
].sort();
const files = [...assets, 'SHA256SUMS'].sort();
// Exercise the real script with isolated command/file adapters, never gh or git.
function script(name) {
  return readFileSync(new URL(name, import.meta.url), 'utf8').replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
}
function publish({ conflict = false, target = sha, annotated = false, moved = false, draft = false } = {}) {
  const calls = [];
  let refs = 0;
  const execFileSync = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === 'git') return sha;
    if (args[0] === 'api') {
      if (args.includes('POST')) {
        assert.ok(args.includes(`sha=${sha}`));
        assert.ok(args.includes('ref=refs/tags/v0.1.2000'));
        if (conflict) throw new Error('422 Reference already exists');
        return '{}';
      }
      if (args[1].includes('/releases?')) return JSON.stringify(draft ? [{ tag_name: 'v0.1.2000', draft: true }] : []);
      if (args[1].includes('/git/ref/')) {
        refs++;
        return JSON.stringify({ object: annotated ? { type: 'tag', sha: 'tag-object' } : { type: 'commit', sha: moved && refs > 1 ? other : target } });
      }
      if (args[1].includes('/git/tags/')) return JSON.stringify({ object: { type: 'commit', sha: target } });
    }
    if (args[0] === 'release' && args[1] === 'create') assert.ok(args.includes('--verify-tag'));
    if (args[0] === 'release' && args[1] === 'view') return JSON.stringify({ assets: files.map((name) => ({ name })) });
    return '';
  };
  let error;
  try {
    runInNewContext(script('release-publish.mjs'), {
      execFileSync, readdirSync: () => [...files, 'release-notes.md'],
      process: { env: { GITHUB_REPOSITORY: 'lingqiqi5211/moepie', VERSION: '0.1.2000' } }, console: { log() {} },
    });
  } catch (e) { error = e; }
  return { calls, refs, error };
}
const released = (calls) => calls.some((c) => c.includes('--draft=false'));
const changedRelease = (calls) => calls.some((c) => c[1] === 'release' && ['delete', 'create', 'edit'].includes(c[2]));

test('publication reserves and rechecks a lightweight tag', () => {
  const r = publish();
  assert.ifError(r.error);
  assert.equal(r.refs, 2);
  assert.ok(released(r.calls));
  const create = r.calls.findIndex((c) => c[1] === 'release' && c[2] === 'create');
  const reserve = r.calls.findIndex((c) => c.includes('POST'));
  assert.ok(reserve >= 0 && reserve < create);
});
for (const annotated of [false, true]) {
  test(`matching ${annotated ? 'annotated' : 'lightweight'} existing tag survives a creation conflict`, () => {
    const r = publish({ conflict: true, annotated, draft: true });
    assert.ifError(r.error);
    assert.ok(released(r.calls));
  });
  test(`wrong ${annotated ? 'annotated' : 'lightweight'} tag blocks draft deletion and publication`, () => {
    const r = publish({ conflict: true, annotated, draft: true, target: other });
    assert.match(r.error?.message || '', /does not point to build commit/);
    assert.equal(changedRelease(r.calls), false);
  });
}
test('a ref moved during upload leaves the release draft', () => {
  const r = publish({ moved: true });
  assert.match(r.error?.message || '', /does not point to build commit/);
  assert.equal(r.refs, 2);
  assert.equal(released(r.calls), false);
});

test('asset manifest accepts all 15 moepie builds and rejects upstream names', () => {
  let written;
  const adapters = {
    createHash, readdirSync: () => assets, statSync: () => ({ size: 5 }), readFileSync: () => 'build',
    writeFileSync: (path, text) => { written = { path, text }; }, console: { log() {} },
  };
  runInNewContext(script('release-assets.mjs'), adapters);
  assert.equal(written.path, 'dist/SHA256SUMS');
  assert.deepEqual(written.text.trim().split('\n').map((line) => line.split('  ')[1]), assets);
  assert.throws(() => runInNewContext(script('release-assets.mjs'), { ...adapters, readdirSync: () => assets.map((a) => a.replace('moepie-', 'magpie-')) }), /Expected exactly 15/);
});
