import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';

const roots: string[] = [];

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wp-pod-catalog-'));
  roots.push(root);
  const productDir = path.join(root, 'products', '123');
  const pod = path.join(productDir, 'pod');
  await fs.mkdir(path.join(pod, 'masks', 'all'), { recursive: true });
  await fs.mkdir(path.join(pod, 'scenes'), { recursive: true });
  await fs.mkdir(path.join(pod, 'previews', 'all'), { recursive: true });
  await fs.writeFile(
    path.join(productDir, 'record.json'),
    JSON.stringify({
      parentId: '123',
      selectedProductId: '456',
      name: 'Test product',
      status: { detail: 'complete', pod: 'complete' },
      validation: { mediaTotal: 3, podFiles: 4 },
      urls: {
        detail: 'https://www.sdsdiy.com/portal/detail/123',
        design: 'https://www.sdsdiy.com/portal/detail/design/123/456',
        sourceSearch: 'https://www.sdsdiy.com/portal/search?sideActiveId=1394',
      },
      categoryMemberships: [{ id: '1394', label: "Women's Clothing" }],
      updatedAt: '2026-08-23T02:40:36.188Z',
    }),
  );
  await fs.writeFile(
    path.join(pod, 'capture.json'),
    JSON.stringify({ parentId: '123', selectedProductId: '456', name: 'Test product', modes: [{ kind: 'all', sides: [{ id: 'side-1' }], viewIds: ['view-1'] }] }),
  );
  await fs.writeFile(
    path.join(pod, 'normalized.json'),
    JSON.stringify({
      modes: [
        {
          name: 'all',
          designSides: [{ id: 'side-1', name: '底片', width: 1042, height: 1200 }],
          views: [{ id: 'view-1', previewPath: 'pod/previews/all/view-1_600.png' }],
        },
      ],
    }),
  );
  await fs.writeFile(path.join(pod, 'previews', 'all', 'view-1_600.png'), 'preview');
  return root;
}

afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))));

describe('catalog index', () => {
  it('rebuilds from the archive and answers queries', async () => {
    const app = await buildApp({ assetsRoot: await fixture(), publicBaseUrl: 'http://test.local' });

    const refresh = await app.inject({ method: 'POST', url: '/v1/catalog/refresh' });
    expect(refresh.statusCode).toBe(200);
    expect(refresh.json()).toMatchObject({ total: 1, added: 1, updated: 0, removed: 0 });

    const list = await app.inject({ url: '/v1/catalog?q=test' });
    expect(list.statusCode).toBe(200);
    const body = list.json();
    expect(body.total).toBe(1);
    expect(body.items[0]).toMatchObject({ id: '123', designProductId: '456' });
    expect(body.items[0].categories[0]).toMatchObject({ id: '1394', label: "Women's Clothing" });
    expect(body.items[0].printAreas[0].sides[0]).toMatchObject({ width: 1042, height: 1200, name: '底片' });
    expect(body.items[0].thumbnailUrl).toContain('/assets/products/123/pod/previews/all/view-1_600.png');
    expect(body.items[0].status).toMatchObject({ detail: 'complete', pod: 'complete' });

    expect((await app.inject({ url: '/v1/catalog?category=1394' })).json().total).toBe(1);
    expect((await app.inject({ url: '/v1/catalog?category=9999' })).json().total).toBe(0);

    const stats = await app.inject({ url: '/v1/catalog/stats' });
    expect(stats.json()).toMatchObject({ total: 1, inArchive: 1, removed: 0 });
    expect(stats.json().categories[0]).toMatchObject({ id: '1394', count: 1 });

    const one = await app.inject({ url: '/v1/catalog/123' });
    expect(one.statusCode).toBe(200);
    expect(one.json().source.detail).toContain('/portal/detail/123');
    expect((await app.inject({ url: '/v1/catalog/999' })).statusCode).toBe(404);
  });
});
