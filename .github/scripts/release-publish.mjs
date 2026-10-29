import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';

const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8' }).trim();
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const repo = process.env.GITHUB_REPOSITORY;
const version = process.env.VERSION;
const sha = git('rev-parse', 'HEAD');
const tag = `v${version}`;
const releases = [];
for (let page = 1; ; page++) {
  const batch = JSON.parse(gh('api', `repos/${repo}/releases?per_page=100&page=${page}`));
  releases.push(...batch);
  if (batch.length < 100) break;
}
const existing = releases.find((r) => r.tag_name === tag);
if (existing && !existing.draft) throw new Error('Release already exists; do not replace published binaries');
const files = readdirSync('dist').filter((f) => f !== 'release-notes.md').sort();
if (files.length !== 16 || !files.includes('SHA256SUMS')) throw new Error('Incomplete release files');
// Reserve the tag explicitly. --target on release create is ignored when a
// ref already exists, and another publisher can create it after preparation.
// Resolve annotated tags as well as lightweight ones, using GitHub's current
// ref rather than checkout's possibly stale tags.
function verifyTag() {
  let object = JSON.parse(gh('api', `repos/${repo}/git/ref/tags/${tag}`)).object;
  const seen = new Set();
  while (object?.type === 'tag' && !seen.has(object.sha)) {
    seen.add(object.sha);
    object = JSON.parse(gh('api', `repos/${repo}/git/tags/${object.sha}`)).object;
  }
  if (object?.type !== 'commit' || object.sha !== sha) {
    throw new Error(`Tag ${tag} does not point to build commit ${sha}`);
  }
}
try {
  gh('api', '-X', 'POST', `repos/${repo}/git/refs`, '-f', `ref=refs/tags/${tag}`, '-f', `sha=${sha}`);
} catch {
  // An existing ref or a creation race is safe only if it resolves to sha.
  // Other API failures also fail closed when the ref cannot be verified.
}
verifyTag();
// A draft from an attempt that died mid-upload is discarded: its attachment
// set is unknown, and the files below were verified again.
if (existing) {
  console.log(`Deleting the draft ${tag} left by an earlier attempt`);
  gh('release', 'delete', tag, '-R', repo, '--yes');
}
const patch = Number(version.split('.')[2]);
const latest = !releases.some((r) => !r.draft && !r.prerelease && /^v0\.1\.\d+$/.test(r.tag_name) && Number(r.tag_name.split('.')[2]) > patch);
// Draft first: the updater cannot observe a release whose uploads are partial.
// --target records the build SHA for prepare's retry/skip lookup only; the
// reserved ref and verifyTag, not that metadata field, bind it to the build.
gh('release', 'create', tag, ...files.map((f) => `dist/${f}`), '-R', repo,
  '--verify-tag', '--target', sha, '--title', `moepie ${tag}`, '--notes-file', 'dist/release-notes.md', '--draft');
const actual = JSON.parse(gh('release', 'view', tag, '-R', repo, '--json', 'assets')).assets.map((a) => a.name).sort();
if (JSON.stringify(actual) !== JSON.stringify(files)) throw new Error('Uploaded asset names do not match; release remains draft');
// Uploading may take minutes: do not publish if the ref moved meanwhile.
verifyTag();
gh('release', 'edit', tag, '-R', repo, '--draft=false', `--latest=${latest}`);
console.log(`Published ${tag} from ${sha} with 16 verified attachments`);
