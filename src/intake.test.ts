import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';

const roots: string[] = [];
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wp-pod-intake-'));
  roots.push(root);
  const pod = path.join(root, 'products', '123', 'pod');
  await fs.mkdir(path.join(pod, 'masks', 'all'), { recursive: true });
  await fs.mkdir(path.join(pod, 'scenes'), { recursive: true });
  await fs.writeFile(path.join(pod, 'capture.json'), JSON.stringify({ parentId: '123', selectedProductId: '456', name: 'Test product', modes: [{ kind: 'single', sides: [{ id: 'side-1' }, { id: 'side-2' }], viewIds: ['view-1'] }] }));
  await fs.writeFile(path.join(pod, 'normalized.json'), JSON.stringify({ modes: [{ name: 'single', designSides: [{ id: 'side-1', width: 599, height: 1200 }, { id: 'side-2', width: 599, height: 1200 }] }] }));
  await fs.writeFile(path.join(pod, 'scenes', 'single.json'), JSON.stringify({ 'view-1': { psdFrames: [] } }));
  await fs.writeFile(path.join(pod, 'masks', 'all', '01_side-1.png'), 'test-mask');
  return root;
}
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))));

const png = (label: string) => 'data:image/png;base64,' + Buffer.from(`fake-png-${label}`).toString('base64');

describe('POD intakes', () => {
  it('saves flattened sides, binds an order, records SDS result and reports daily stats', async () => {
    const app = await buildApp({ assetsRoot: await fixture(), publicBaseUrl: 'http://test.local' });
    const created = await app.inject({
      method: 'POST',
      url: '/v1/intakes',
      payload: {
        designId: '11111111-1111-4111-8111-111111111111',
        productId: '123',
        productName: 'Test product',
        mode: { kind: 'single', templateName: 'LM254-多拼' },
        source: 'designer_harness',
        sides: [
          { sideId: 'side-1', name: '前片', width: 599, height: 1200, dataUrl: png('front') },
          { sideId: 'side-2', name: '包边', width: 599, height: 1200, dataUrl: png('binding') }
        ]
      }
    });
    expect(created.statusCode).toBe(201);
    const record = created.json();
    expect(record.status).toBe('pending');
    expect(record.modeKind).toBe('single');
    expect(record.sides).toHaveLength(2);
    expect(record.sides[0].url).toBe(`http://test.local/v1/intakes/${record.id}/sides/side-1.png`);
    expect(record.sides[0].sha256).toMatch(/^[a-f0-9]{64}$/);

    const side = await app.inject({ url: `/v1/intakes/${record.id}/sides/side-1.png` });
    expect(side.statusCode).toBe(200);
    expect(side.headers['content-type']).toContain('image/png');
    expect(side.rawPayload.toString()).toBe('fake-png-front');

    const order = await app.inject({
      method: 'POST',
      url: `/v1/intakes/${record.id}/orders`,
      payload: { size: 'M', quantity: 2, orderName: '#TEST-1', orderId: '999', source: 'simulate' }
    });
    expect(order.statusCode).toBe(201);
    expect(order.json().size).toBe('M');

    const detail = (await app.inject({ url: `/v1/intakes/${record.id}` })).json();
    expect(detail.orders).toHaveLength(1);
    expect(detail.orders[0].quantity).toBe(2);

    const patch = await app.inject({ method: 'POST', url: `/v1/intakes/${record.id}/sds`, payload: { status: 'cart_added', sds: { sdsCartAt: '2026-09-22T00:00:00.000Z' } } });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().status).toBe('cart_added');
    expect(patch.json().sdsAt).toBeTruthy();

    const stats = (await app.inject({ url: '/v1/intakes/stats?days=3' })).json();
    expect(stats.persistent).toBe(false);
    expect(stats.today.created).toBe(1);
    expect(stats.today.cartAdded).toBe(1);
    expect(stats.today.pending).toBe(0);
    expect(stats.today.ordered).toBe(1);
    expect(stats.today.orderUnits).toBe(2);

    const pending = (await app.inject({ url: '/v1/intakes?status=pending' })).json();
    expect(pending.total).toBe(0);
    const byDesign = (await app.inject({ url: `/v1/intakes?limit=10` })).json();
    expect(byDesign.total).toBe(1);

    const ops = await app.inject({ url: '/ops/intakes' });
    expect(ops.statusCode).toBe(200);
    expect(ops.headers['content-type']).toContain('text/html');
    expect(ops.body).toContain('待与 SDS 交互');
    await app.close();
  });

  it('rejects malformed intakes and unknown products', async () => {
    const app = await buildApp({ assetsRoot: await fixture(), publicBaseUrl: 'http://test.local' });
    const bad = await app.inject({ method: 'POST', url: '/v1/intakes', payload: { productId: '123', mode: { kind: 'single' }, sides: [] } });
    expect(bad.statusCode).toBe(400);
    const missing = await app.inject({
      method: 'POST',
      url: '/v1/intakes',
      payload: { productId: '999', mode: { kind: 'all' }, sides: [{ sideId: 's', dataUrl: png('x') }] }
    });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });
});
