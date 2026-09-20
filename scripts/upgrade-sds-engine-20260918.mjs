import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import vm from 'node:vm';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = 'https://cdn-static.sdspod.com/v1789733095269/js/';
const specs = [
  { file: 'sds-app-runtime.js', source: base + 'app.8a3533aadb933362491e.js', patches: [
    ['var O=S;return r(r.s=723)', 'var O=S;return window.SDSWebpackRequire=r,r']
  ] },
  { file: 'sds-vetrina-chunk.js', source: base + '18.c2916d9b4dea533dd3b7.js', patches: [
    ['D=D.default}()})}).call(this,H(304),H(481).Buffer,H(302)(tr))', 'D=D.default,window.SDSVetrina=D.Vetrina}()})}).call(this,H(304),H(481).Buffer,H(302)(tr))'],
    ['fetch("https://static-photo-center-prov.oss-cn-hangzhou.aliyuncs.com/static/favicon.ico")', 'fetch("assets/sds-scene/vetrina-formatter.ico")']
  ] }
];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const manifestPath = path.join(root, 'scripts/sds-engine-20260918.manifest.json');
let priorManifest = { files: [] };
try { priorManifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')); } catch (e) { if(e.code !== 'ENOENT') throw e; }
const priorHash = (file, current) => priorManifest.files.find(f => f.file === file)?.previousSha256 || hash(current);
const formatterSource = 'https://static-photo-center-prov.oss-cn-hangzhou.aliyuncs.com/static/favicon.ico';
const formatterResponse = await fetch(formatterSource);
if (!formatterResponse.ok) throw new Error('Formatter download failed');
const formatterBytes = Buffer.from(await formatterResponse.arrayBuffer());
if (hash(formatterBytes) !== 'ef827c91108f2cf52e5ae3caf0a02b44db6adf1b51373e4e805673e16555145d') throw new Error('Formatter upstream changed; review before updating');
const formatterFiles = ['assets/sds-scene/vetrina-formatter.ico', 'v2/assets/sds-scene/vetrina-formatter.ico', 'v3/assets/sds-scene/vetrina-formatter.ico'];
const prepared = [];
for (const spec of specs) {
  const response = await fetch(spec.source);
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${spec.source}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const original = bytes.toString('utf8');
  if (!original.startsWith('/*! Last update: 9/18/2026, 8:04:55 PM */')) throw new Error('Unexpected upstream build');
  let patched = original;
  for (const [from, to] of spec.patches) {
    if (patched.split(from).length !== 2) throw new Error(`Patch must match exactly once: ${from}`);
    patched = patched.replace(from, to);
  }
  new vm.Script(patched, { filename: spec.file });
  prepared.push({ ...spec, bytes, patched, original });
}
// Verify the renderer entry is still present before touching either vendor file.
const registry = [];
vm.runInNewContext(prepared[1].patched, { window: { webpackJsonp: registry } });
if (typeof registry[0]?.[1]?.[1007] !== 'function') throw new Error('Missing renderer module 1007');
const manifest = { upstreamBuild: 'v1789733095269', buildComment: '9/18/2026, 8:04:55 PM', rendererModuleId: 1007, scope: 'Only engine bundles; retain existing export and local formatter adapters. No UI, scene, cropping or rendering parameter changes.', files: [] };
for (const item of prepared) {
  const dest = path.join(root, 'public/vendor', item.file);
  const previous = await fs.readFile(dest);
  manifest.files.push({ file: 'public/vendor/' + item.file, source: item.source, previousSha256: priorHash('public/vendor/' + item.file, previous), upstreamSha256: hash(item.bytes), installedSha256: hash(item.patched), patches: item.patches.map(([from,to]) => ({ from,to })) });
}
for (const file of formatterFiles) {
  const previous = await fs.readFile(path.join(root, 'public/vendor', file));
  manifest.files.push({file: 'public/vendor/' + file, source: formatterSource, previousSha256: priorHash('public/vendor/' + file, previous), upstreamSha256: hash(formatterBytes), installedSha256: hash(formatterBytes), patches: []});
}
for (const file of formatterFiles) await fs.writeFile(path.join(root, 'public/vendor', file), formatterBytes);
for (const item of prepared) await fs.writeFile(path.join(root, 'public/vendor', item.file), item.patched, 'utf8');
await fs.writeFile(path.join(root, 'scripts/sds-engine-20260918.manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify(manifest, null, 2));
