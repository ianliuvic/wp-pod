import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';

const roots: string[] = [];
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wp-pod-')); roots.push(root);
  const pod = path.join(root, 'products', '123', 'pod');
  await fs.mkdir(path.join(pod, 'masks', 'all'), { recursive: true });
  await fs.writeFile(path.join(pod, 'capture.json'), JSON.stringify({ parentId: '123', selectedProductId: '456', name: 'Test product', modes: [{ kind: 'all', sides: [{ id: 'side-1', editorCanvas: { width: 900, height: 900 } }], viewIds: ['view-1'] }] }));
  await fs.writeFile(path.join(pod, 'normalized.json'), JSON.stringify({ modes: [{ name: 'all', designSides: [{ id: 'side-1', width: 1042, height: 1200 }] }] }));
  return root;
}
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))));
describe('API', () => {
  it('returns health and a normalized product manifest', async () => {
    const app = await buildApp({ assetsRoot: await fixture(), publicBaseUrl: 'http://test.local' });
    expect((await app.inject({ url: '/health' })).statusCode).toBe(200);
    const response = await app.inject({ url: '/v1/products/123/manifest' });
    expect(response.statusCode).toBe(200);
    const mode = response.json().modes[0];
    expect(mode).not.toHaveProperty('scene');
    expect(mode.sceneUrl).toBe('http://test.local/assets/products/123/pod/scenes/all.json');
    expect(mode.sides[0].maskUrl).toContain('/assets/products/123/pod/masks/all/01_side-1.png');
    expect(mode.sides[0].previewWidth).toBe(1042);
    const renderer = await app.inject({ url: '/vendor/v3/renderer-frame.html' });
    expect(renderer.statusCode).toBe(200);
    expect(renderer.body).toContain('Number(message.sceneItemRenderSize)');
    await app.close();
  });

  it('preserves advanced designer fields without breaking schema v1', async () => {
    const app = await buildApp({ assetsRoot: await fixture(), publicBaseUrl: 'http://test.local' });
    const design = {
      schemaVersion: 1,
      productId: '123',
      mode: 'single',
      background: '#ffffff',
      backgrounds: { 'side-1': '#112233' },
      layers: [{
        id: '1', kind: 'image', sideId: 'side-1', sourceUrl: 'https://cdn.example.com/source.png',
        x: 0.5, y: 0.5, scaleX: -1, scaleY: 1, rotation: 15, opacity: 0.8, zIndex: 0,
        boxW: 72, boxH: 64, fit: 'tile', imageMode: 'tile', tile: 'mirror', tileSize: 35,
        crop: { x: 0.1, y: 0.2, width: 0.7, height: 0.6 }, filter: 'contrast', filterValue: 120
      }],
      quantities: {},
      previews: ['https://cdn.example.com/preview.webp'],
      surfaces: [{ sideId: 'side-1', name: 'Front', url: 'https://cdn.example.com/surface.webp', width: 1042, height: 1200, format: 'webp' }],
      automation: { jobId: 'job-1', requestedAt: '2026-08-21T00:00:00.000Z', planVersion: 1 }
    };
    const saved = await app.inject({ method: 'POST', url: '/v1/designs', payload: design });
    expect(saved.statusCode).toBe(201);
    const record = saved.json();
    expect(record.design.backgrounds['side-1']).toBe('#112233');
    expect(record.design.layers[0].tile).toBe('mirror');
    expect(record.design.layers[0].scaleX).toBe(-1);
    expect(record.design.surfaces[0].sideId).toBe('side-1');
    expect(record.design.automation.jobId).toBe('job-1');
    const fetched = await app.inject({ url: `/v1/designs/${record.id}` });
    expect(fetched.json().design.layers[0].filterValue).toBe(120);
    await app.close();
  });
});
