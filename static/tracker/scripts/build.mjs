// Builds the Custom UI resource into ./build (the folder manifest.yml points at).
//   npm run build        -> real build for `forge deploy`
//   npm run build:mock   -> ./build-mock, with @forge/bridge replaced by test/mock-bridge.js and
//                           fixture data, so the page can be opened locally without Jira.
import {build} from 'esbuild';
import {cpSync, rmSync, mkdirSync, existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const mock = process.argv.includes('--mock');
const out = join(root, mock ? 'build-mock' : 'build');

rmSync(out, {recursive: true, force: true});
mkdirSync(out, {recursive: true});
cpSync(join(root, 'public'), out, {recursive: true});
if (mock && existsSync(join(root, 'test', 'fixtures'))) cpSync(join(root, 'test', 'fixtures'), join(out, 'fixtures'), {recursive: true});

await build({
  entryPoints: [join(root, 'src', 'shim.js')],
  outfile: join(out, 'shim.js'),
  bundle: true,
  format: 'iife',
  target: ['es2020'],
  minify: !mock,
  sourcemap: mock,
  alias: mock ? {'@forge/bridge': join(root, 'test', 'mock-bridge.js')} : {},
  logLevel: 'info',
});
console.log(`Built ${mock ? 'mock ' : ''}UI into ${out}`);
