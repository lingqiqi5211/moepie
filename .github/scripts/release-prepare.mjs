import { appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const api = (path) => JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8' }));
const repo = process.env.GITHUB_REPOSITORY;
const sha = git('rev-parse', 'HEAD');
git('merge-base', '--is-ancestor', sha, 'origin/main');
const runs = api(`repos/${repo}/actions/workflows/test.yml/runs?head_sha=${sha}&event=push&status=success&per_page=100`).workflow_runs;
if (!runs.some((r) => r.head_sha === sha && r.head_branch === 'main' && r.head_repository?.full_name === repo && r.conclusion === 'success')) {
  throw new Error(`Test has not passed for main commit ${sha}`);
}
let version = process.env.INPUT_VERSION || '';
const tags = git('tag', '--list', 'v0.1.*').split('\n');
const releases = [];
for (let page = 1; ; page++) {
  const batch = api(`repos/${repo}/releases?per_page=100&page=${page}`);
  releases.push(...batch);
  if (batch.length < 100) break;
}
// Rerunning a successfully published commit is a no-op. A failed build
// creates no tag or release, so it can be retried normally.
const published = releases.find((r) => !r.draft && r.target_commitish === sha);
if (!version && published) {
  appendFileSync(process.env.GITHUB_OUTPUT, 'skip=true\n');
  process.exit(0);
}
// A publish that died after making its draft leaves a reserved number: reuse
// it for the same commit instead of burning a patch version.
if (!version) version = releases.find((r) => r.draft && r.target_commitish === sha)?.tag_name.replace(/^v/, '') || '';
if (!version) {
  const patches = [...tags, ...releases.map((r) => r.tag_name)]
    .map((t) => /^v0\.1\.(\d+)$/.exec(t)?.[1]).filter(Boolean).map(Number);
  version = `0.1.${Math.max(0, ...patches) + 1}`;
}
if (!/^0\.1\.(0|[1-9]\d*)$/.test(version)) throw new Error('Version must be 0.1.N, without a v prefix');
if (tags.includes(`v${version}`)) {
  if (git('rev-list', '-n', '1', `v${version}`) !== sha) throw new Error('Tag belongs to another commit');
}
const existing = releases.find((r) => r.tag_name === `v${version}`);
if (existing && !existing.draft) throw new Error('This version already has a release');
if (existing && existing.target_commitish !== sha) throw new Error('The draft release for this version targets another commit');
appendFileSync(process.env.GITHUB_OUTPUT, `skip=false\nsha=${sha}\nversion=${version}\n`);
appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Building fork commit ${sha} as v${version}.\n`);
