import { describe, expect, it } from 'vitest';
import { CatalogStore } from './catalog-store.js';
import type { CatalogSnapshotEntry } from './asset-store.js';
import { runShelfCheck } from './shelf.js';

function entry(id: string, name: string): CatalogSnapshotEntry {
  return {
    id,
    name,
    designProductId: null,
    modes: ['all'],
    categories: [{ id: '1394', label: "Women's Clothing" }],
    thumbnailUrl: null,
    printAreas: [],
    status: { detail: 'complete', pod: 'complete' },
    validation: {},
    source: { detail: null, design: null, search: null, capturedAt: null },
    recordUpdatedAt: null,
  };
}

describe('shelf check', () => {
  it('marks delisted products, restores relisted ones and reports new listings', async () => {
    const catalog = new CatalogStore(undefined, 'pod_products_test');
    await catalog.replaceAll([entry('1', 'Stays'), entry('2', 'Goes away'), entry('3', 'Comes back')]);
    // Product 3 was delisted by an earlier run and is listed again now.
    await catalog.applyShelfStatus({ delistedIds: ['3'], restoredIds: [] });
    expect((await catalog.get('3'))?.shelfStatus).toBe('delisted');

    const listedByCategory: Record<string, Array<{ id: number; name: string; categories: Array<{ id: number }> }>> = {
      '1394': [
        { id: 1, name: 'Stays', categories: [{ id: 1394 }] },
        { id: 3, name: 'Comes back', categories: [{ id: 1394 }] },
        { id: 999, name: 'Brand new', categories: [{ id: 1394 }] }
      ]
    };
    const fetcher = (async (input: unknown) => {
      const categoryId = new URL(String(input)).searchParams.get('categoryId') ?? '';
      const items = listedByCategory[categoryId] ?? [];
      return new Response(JSON.stringify({ totalCount: items.length, items }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }) as unknown as typeof fetch;

    const report = await runShelfCheck(catalog, { fetcher, notify: false });

    expect(report.catalogCount).toBe(3);
    expect(report.delisted.map((item) => item.id)).toEqual(['2']);
    expect(report.restored.map((item) => item.id)).toEqual(['3']);
    expect(report.newListed.map((item) => item.id)).toEqual(['999']);

    expect((await catalog.get('2'))?.shelfStatus).toBe('delisted');
    expect((await catalog.get('2'))?.delistedAt).toBeTruthy();
    expect((await catalog.get('3'))?.shelfStatus).toBe('listed');
    expect((await catalog.get('3'))?.restoredAt).toBeTruthy();

    const { items } = await catalog.list({ shelfStatus: 'delisted' });
    expect(items.map((item) => item.id)).toEqual(['2']);
  });
});
