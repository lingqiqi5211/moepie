import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

test('builds, launch checks and updater agree on the moepie executable and bundle', () => {
  const make = read('Makefile');
  for (const name of ['-o moepie .', 'moepie.app/Contents/MacOS/moepie', 'dist/moepie-cli-', 'dist/moepie-windows-', 'dist/moepie-linux-']) assert.ok(make.includes(name), name);
  const workflow = read('.github/workflows/release.yml');
  for (const name of ['moepie.app', 'moepie-darwin-', 'dist/moepie-cli-', 'dist\\moepie-windows-', 'dist/moepie-linux-', '"moepie $env:VERSION*"', '"moepie $VERSION"']) assert.ok(workflow.includes(name), name);
  assert.equal((read('internal/cli/main.go').match(/fmt.Println\("moepie", version\)/g) || []).length, 2);
  assert.ok(read('internal/update/update.go').includes('filepath.Join(out, "moepie.app")'));
  const notes = read('.github/scripts/release-notes.mjs');
  for (const name of ['moepie-darwin-<arch>.dmg', 'moepie-windows-<arch>.exe', 'moepie-linux-<arch>', 'moepie-cli-<os>-<arch>']) assert.ok(notes.includes(name), name);
});

test('visible shell branding changes without migrating stored data or import protocols', () => {
  const html = read('internal/gui/assets/index.html');
  for (const name of ['<title>moepie</title>', '<span>moepie</span>', 'content="moepie"', '>Open moepie</button>']) assert.ok(html.includes(name), name);
  const manifest = JSON.parse(read('internal/gui/assets/manifest.json'));
  assert.equal(manifest.name, 'moepie');
  assert.equal(manifest.short_name, 'moepie');
  assert.ok(read('internal/gui/app.go').includes('Name:           "moepie"'));
  assert.ok(read('internal/gui/lightweight.go').includes('Title:            "moepie"'));
  assert.ok(read('internal/gui/scheme_linux.go').includes('\nName=moepie\n'));
  assert.ok(read('internal/gui/desktop.go').includes('const programName = "magpie"'));
  assert.ok(read('internal/gui/scheme_windows.go').includes('Software\\Classes\\magpie'));
  const win = JSON.parse(read('build/windows/winres.json'));
  const info = win.RT_VERSION['#1']['0000'].info['0409'];
  assert.equal(info.ProductName, 'moepie');
  assert.equal(info.FileDescription, 'moepie');
  assert.equal(info.OriginalFilename, 'moepie.exe');
  assert.match(info.LegalCopyright, /yetone/);
  const plist = read('build/darwin/Info.plist');
  assert.match(plist, /CFBundleExecutable<\/key><string>moepie<\/string>/);
  assert.match(plist, /io.github.lingqiqi5211.moepie/);
  assert.match(plist, /CFBundleURLSchemes<\/key><array><string>magpie<\/string>/);
  for (const line of read('internal/gui/assets/i18n.js').split('\n').filter((l) => l.includes('"Open moepie":'))) assert.ok(line.match(/moepie/g).length === 2);
});
