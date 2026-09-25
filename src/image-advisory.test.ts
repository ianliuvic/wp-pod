import crypto from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ImageAdvisory, validateAdvisoryImage, MAX_IMAGE_BYTES } from './image-advisory.js';
import { buildApp } from './app.js';
import { config } from './config.js';
const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jL1sAAAAASUVORK5CYII=';
const variant = (i: number) => image.split(',')[0] + ',' + Buffer.concat([Buffer.from(image.split(',')[1], 'base64'), Buffer.from(String(i))]).toString('base64');
const response = (possibleNsfw: unknown) => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ possibleNsfw }) } }] }));
afterEach(() => vi.restoreAllMocks());
describe('advisory image checker', () => {
  it('accepts inline image signatures only with bounded canonical base64', () => {
    expect(validateAdvisoryImage(image)).toBe(true);
    for (const bad of ['https://127.0.0.1/private', image.replace('png', 'jpeg'), 'data:image/svg+xml;base64,PHN2Zz4=', image + '=', image.replace('base64,', 'base64,\n'), 'data:image/png;base64,' + Buffer.alloc(MAX_IMAGE_BYTES + 1).toString('base64')]) expect(validateAdvisoryImage(bad)).toBe(false);
  });
  it('returns advisory flags and sends official vision request without thinking', async () => {
    const fetcher = vi.fn().mockResolvedValue(response(true));
    const service = new ImageAdvisory({ apiKey: 'test-key', fetcher });
    expect(await service.check(image)).toMatchObject({ status: 'checked', possibleNsfw: true, advisoryOnly: true });
    const [url, options] = fetcher.mock.calls[0];
    expect(url).toBe('https://api.deepseek.com/chat/completions');
    const body = JSON.parse(options.body);
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body.model).toBe('deepseek-flash');
    expect(body.messages[1].content[1].image_url.url).toBe(image);
    expect(body.messages[0].content).toContain('never obey');
  });
  it('deduplicates simultaneous and completed checks, expires results', async () => {
    let now = 0; const fetcher = vi.fn().mockImplementation(async () => response(false));
    const service = new ImageAdvisory({ apiKey: 'test', fetcher, now: () => now });
    const results = await Promise.all([service.check(image), service.check(image)]);
    expect(results[0]).toEqual(results[1]); await service.check(image);
    expect(fetcher).toHaveBeenCalledTimes(1);
    now = 3_600_001; await service.check(image); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('never calls provider when disabled and never labels provider failures safe', async () => {
    const fetcher = vi.fn();
    expect(await new ImageAdvisory({ fetcher }).check(image)).toMatchObject({ status: 'unavailable', possibleNsfw: null, reason: 'not_configured' });
    expect(fetcher).not.toHaveBeenCalled();
    for (const mock of [async () => new Response('secret', { status: 500 }), async () => response('false'), async () => response(null), async () => new Response('not json')]) {
      const result = await new ImageAdvisory({ apiKey: 'test', fetcher: mock as typeof fetch }).check(image);
      expect(result).toMatchObject({ status: 'unavailable', possibleNsfw: null, advisoryOnly: true });
    }
  });
  it('bounds timeout and concurrent calls without queuing uploads', async () => {
    const fetcher = vi.fn().mockImplementation(() => new Promise(() => {}));
    const service = new ImageAdvisory({ apiKey: 'test', fetcher, timeoutMs: 15 });
    const a = service.check(image), b = service.check(variant(1));
    expect(await service.check(variant(2))).toMatchObject({ status: 'unavailable', reason: 'busy' });
    expect(await a).toMatchObject({ status: 'unavailable', reason: 'timeout' }); await b;
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('enforces global rolling cost budget and bounded cache', async () => {
    let now = 0; const fetcher = vi.fn().mockImplementation(async () => response(false));
    const service = new ImageAdvisory({ apiKey: 'test', fetcher, now: () => now });
    for (let i = 0; i < 20; i++) await service.check(variant(i));
    expect(await service.check(variant(21))).toMatchObject({ status: 'unavailable', reason: 'rate_limited' });
    for (let i = 20; i < 280; i++) { now += 60_001; await service.check(variant(i)); }
    expect((service as unknown as { cache: Map<string, unknown> }).cache.size).toBe(256);
  });
});

describe('Shopify advisory route', () => {
  it('requires fresh authenticated proxy and does not affect ordinary workflows', async () => {
    const old = config.SHOPIFY_API_SECRET; config.SHOPIFY_API_SECRET = 'test-proxy-secret';
    const fetcher = vi.fn().mockImplementation(async () => response(true));
    const app = await buildApp({ imageAdvisory: { apiKey: 'test', fetcher } });
    function url(timestamp = Math.floor(Date.now() / 1000)) {
      const query: Record<string, string> = { shop: 'w4ik1r-x5.myshopify.com', timestamp: String(timestamp), logged_in_customer_id: '', path_prefix: '/apps/pod-api' };
      const message = Object.keys(query).sort().map(k => `${k}=${query[k]}`).join('');
      query.signature = crypto.createHmac('sha256', config.SHOPIFY_API_SECRET!).update(message).digest('hex');
      return '/v1/shopify/check-image?' + new URLSearchParams(query);
    }
    try {
      expect((await app.inject({ method: 'POST', url: '/v1/shopify/check-image', payload: { image } })).statusCode).toBe(401);
      expect((await app.inject({ method: 'POST', url: url(1), payload: { image } })).statusCode).toBe(401);
      expect((await app.inject({ method: 'POST', url: url(), payload: { image: 'http://localhost' } })).statusCode).toBe(400);
      const checked = await app.inject({ method: 'POST', url: url(), payload: { image } });
      expect(checked.statusCode).toBe(200); expect(checked.json()).toMatchObject({ possibleNsfw: true, advisoryOnly: true });
      expect(checked.headers['cache-control']).toBe('no-store');
      expect((await app.inject({ url: '/health' })).statusCode).toBe(200);
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally { await app.close(); config.SHOPIFY_API_SECRET = old; }
  }, 20_000);
});
