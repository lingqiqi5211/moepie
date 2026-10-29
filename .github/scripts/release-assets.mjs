import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';

export const expectedAssets = [
  ...['arm64', 'amd64'].flatMap((a) => [`moepie-darwin-${a}.dmg`, `moepie-darwin-${a}.zip`]),
  ...['darwin-arm64', 'darwin-amd64', 'linux-amd64', 'linux-arm64', 'android-arm64'].map((p) => `moepie-cli-${p}`),
  ...['amd64', 'arm64'].flatMap((a) => [`moepie-cli-windows-${a}.exe`, `moepie-windows-${a}.exe`, `moepie-linux-${a}`]),
].sort();

const actual = readdirSync('dist').sort();
if (JSON.stringify(actual) !== JSON.stringify(expectedAssets)) {
  throw new Error(`Expected exactly 15 build files. Got: ${actual.join(', ')}`);
}
const sums = expectedAssets.map((name) => {
  if (!statSync(`dist/${name}`).size) throw new Error(`Empty asset: ${name}`);
  return `${createHash('sha256').update(readFileSync(`dist/${name}`)).digest('hex')}  ${name}`;
});
writeFileSync('dist/SHA256SUMS', sums.join('\n') + '\n');
console.log('Verified all 15 build files; wrote SHA256SUMS');
