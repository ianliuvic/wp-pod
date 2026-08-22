import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { FastifyReply } from 'fastify';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import fastifyRateLimit from '@fastify/rate-limit';
import { z } from 'zod';
import { config } from './config.js';
import { AssetStore } from './asset-store.js';
import { DesignStore } from './design-store.js';
import { designSchema, renderRequestSchema } from './schemas.js';
import { MonitoringCollector } from './monitoring.js';
import { rateLimitPolicy, type RateLimitSettings } from './rate-limits.js';
import { removeImageBackground } from './background-removal.js';

const backgroundRemovalRequestSchema = z.object({
  image: z.string().max(8_000_000).refine((value) => /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(value) || /^https:\/\//.test(value))
});

export async function buildApp(options: { assetsRoot?: string; publicBaseUrl?: string; paintsandApiKey?: string; monitoringToken?: string; rateLimits?: Partial<RateLimitSettings>; replicateApiToken?: string } = {}) {
  const app = Fastify({ logger: config.NODE_ENV !== 'test', trustProxy: ['loopback', 'linklocal', 'uniquelocal'] });
  const monitoring = new MonitoringCollector();
  const requestStartedAt = new WeakMap<object, bigint>();
  const assetsRoot = options.assetsRoot ?? config.assetsRoot;
  const assetStore = new AssetStore(assetsRoot, options.publicBaseUrl ?? config.PUBLIC_BASE_URL);
  const designs = new DesignStore(config.DATABASE_URL, 'designs');
  const paintsandDesigns = new DesignStore(config.DATABASE_URL, 'paintsand_designs');
  await designs.init();
  await paintsandDesigns.init();
  const paintsandApiKey = options.paintsandApiKey ?? config.PAINTSAND_API_KEY;
  const monitoringToken = options.monitoringToken ?? config.MONITORING_TOKEN;
  const replicateApiToken = options.replicateApiToken ?? config.REPLICATE_API_TOKEN;
  const limits: RateLimitSettings = { ...config.rateLimits, ...options.rateLimits };
  const backgroundRemovalCache = new Map<string, { image: string; expiresAt: number }>();
  const backgroundRemovalJobs = new Map<string, Promise<string>>();
  function verifyShopifyProxy(request: { query: unknown }, reply: { code: (status: number) => { send: (body: unknown) => unknown } }) {
    if (!config.SHOPIFY_API_SECRET) return reply.code(503).send({ error: 'shopify_proxy_not_configured' });
    const query = request.query as Record<string, unknown>;
    const signature = typeof query.signature === 'string' ? query.signature : '';
    const shop = typeof query.shop === 'string' ? query.shop.toLowerCase() : '';
    const allowedShops = [config.SHOPIFY_SHOP_DOMAIN.toLowerCase(), 'w4ik1r-x5.myshopify.com'];
    if (!signature || !allowedShops.includes(shop)) return reply.code(401).send({ error: 'invalid_shopify_proxy_request' });
    const message = Object.keys(query).filter((key) => key !== 'signature').sort().map((key) => `${key}=${Array.isArray(query[key]) ? (query[key] as unknown[]).join(',') : String(query[key])}`).join('');
    const expected = crypto.createHmac('sha256', config.SHOPIFY_API_SECRET).update(message).digest('hex');
    if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return reply.code(401).send({ error: 'invalid_shopify_proxy_signature' });
    return null;
  }
  function verifyPaintsand(request: { headers: Record<string, unknown> }, reply: { code: (status: number) => { send: (body: unknown) => unknown } }) {
    if (!paintsandApiKey) return reply.code(503).send({ error: 'paintsand_api_not_configured' });
    const supplied = typeof request.headers['x-paintsand-api-key'] === 'string' ? request.headers['x-paintsand-api-key'] : '';
    const expected = Buffer.from(paintsandApiKey);
    const received = Buffer.from(supplied);
    if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) return reply.code(401).send({ error: 'unauthorized' });
    return null;
  }
  await app.register(cors, { origin: (origin, cb) => cb(null, !origin || config.corsOrigins.includes(origin)) });
  await app.register(fastifyRateLimit, { global: false });
  function setAssetCacheHeaders(reply: FastifyReply, filePath: string): void {
    const ext = path.extname(filePath).toLowerCase();
    if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.avif', '.ico', '.woff', '.woff2', '.ttf', '.psd'].includes(ext)) {
      reply.header('Cache-Control', 'public, max-age=31536000, immutable');
    } else if (ext === '.json') {
      reply.header('Cache-Control', 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800');
    } else {
      reply.header('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
    }
    reply.header('Vary', 'Accept-Encoding');
  }
  function setVendorCacheHeaders(reply: FastifyReply, filePath: string): void {
    const ext = path.extname(filePath).toLowerCase();
    if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.avif', '.ico', '.woff', '.woff2', '.ttf'].includes(ext)) {
      reply.header('Cache-Control', 'public, max-age=31536000, immutable');
    } else {
      reply.header('Cache-Control', 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800');
    }
    reply.header('Vary', 'Accept-Encoding');
  }
  if (fs.existsSync(assetsRoot)) await app.register(fastifyStatic, { root: assetsRoot, prefix: '/assets/', decorateReply: false, setHeaders: setAssetCacheHeaders });
  const vendorRoot = path.resolve('public/vendor');
  if (fs.existsSync(vendorRoot)) await app.register(fastifyStatic, { root: vendorRoot, prefix: '/vendor/', decorateReply: false, setHeaders: setVendorCacheHeaders });

  app.addHook('onRequest', async (request, reply) => {
    if (request.url.startsWith('/v1/shopify/') || request.url.startsWith('/v1/paintsand/') || !config.API_KEY || request.url === '/health' || request.method === 'GET') return;
    if (request.headers['x-api-key'] !== config.API_KEY) return reply.code(401).send({ error: 'unauthorized' });
  });
  app.addHook('onRequest', async (request) => {
    requestStartedAt.set(request, process.hrtime.bigint());
  });
  app.addHook('onResponse', async (request, reply) => {
    const startedAt = requestStartedAt.get(request);
    if (typeof startedAt !== 'bigint') return;
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    monitoring.record(request.routeOptions.url, request.url, reply.statusCode, durationMs);
  });
  app.get('/health', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { status: 'ok', service: 'wp-pod', version: '0.1.0', assetsMounted: fs.existsSync(assetsRoot) };
  });
  app.get('/internal/metrics', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!monitoringToken) return reply.code(503).send({ error: 'monitoring_not_configured' });
    const supplied = typeof request.headers.authorization === 'string' ? request.headers.authorization : '';
    const expected = Buffer.from(`Bearer ${monitoringToken}`);
    const received = Buffer.from(supplied);
    if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) return reply.code(401).send({ error: 'unauthorized' });
    return monitoring.snapshot(fs.existsSync(assetsRoot) ? assetsRoot : process.cwd());
  });
  app.get('/v1/products', { config: { rateLimit: rateLimitPolicy('wordpress', 'product-list', limits.productListMax, limits.windowMs) } }, async (_request, reply) => {
    reply.header('Cache-Control', 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400');
    return { products: await assetStore.listProducts() };
  });
  app.get<{ Querystring: Record<string, unknown>; Params: { productId: string } }>('/v1/shopify/manifest/:productId', { config: { rateLimit: rateLimitPolicy('shopify', 'manifest', limits.manifestMax, limits.windowMs) } }, async (request, reply) => {
    const denied = verifyShopifyProxy(request, reply); if (denied) return denied;
    reply.header('Cache-Control', 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400');
    try { return await assetStore.manifest(request.params.productId); } catch { return reply.code(404).send({ error: 'product_not_found' }); }
  });
  app.post<{ Querystring: Record<string, unknown> }>('/v1/shopify/designs', { config: { rateLimit: rateLimitPolicy('shopify', 'design-write', limits.designWriteMax, limits.windowMs) } }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const denied = verifyShopifyProxy(request, reply); if (denied) return denied;
    const parsed = designSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_design', issues: parsed.error.flatten() });
    try { await assetStore.manifest(parsed.data.productId); } catch { return reply.code(404).send({ error: 'product_not_found' }); }
    return reply.code(201).send(await designs.upsert(parsed.data));
  });
  app.post<{ Querystring: Record<string, unknown> }>('/v1/shopify/remove-background', { bodyLimit: 8_100_000, config: { rateLimit: rateLimitPolicy('shopify', 'background-removal', limits.renderMax, limits.windowMs) } }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const denied = verifyShopifyProxy(request, reply); if (denied) return denied;
    const parsed = backgroundRemovalRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_background_removal_image' });
    if (!replicateApiToken) return reply.code(503).send({ error: 'background_removal_not_configured' });
    const key = crypto.createHash('sha256').update(parsed.data.image).digest('hex');
    const cached = backgroundRemovalCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return { image: cached.image, cached: true };
    let job = backgroundRemovalJobs.get(key);
    if (!job) {
      job = removeImageBackground(parsed.data.image, replicateApiToken);
      backgroundRemovalJobs.set(key, job);
    }
    try {
      const image = await job;
      backgroundRemovalCache.set(key, { image, expiresAt: Date.now() + 45 * 60_000 });
      return { image, cached: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (message === 'replicate_timeout' || error instanceof DOMException && error.name === 'TimeoutError') return reply.code(504).send({ error: 'background_removal_timeout' });
      return reply.code(502).send({ error: 'background_removal_unavailable' });
    } finally {
      backgroundRemovalJobs.delete(key);
    }
  });
  app.get<{ Params: { productId: string } }>('/v1/products/:productId/manifest', { config: { rateLimit: rateLimitPolicy('wordpress', 'manifest', limits.manifestMax, limits.windowMs) } }, async (request, reply) => {
    reply.header('Cache-Control', 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400');
    try { return await assetStore.manifest(request.params.productId); }
    catch { return reply.code(404).send({ error: 'product_not_found' }); }
  });
  app.post('/v1/designs', { config: { rateLimit: rateLimitPolicy('wordpress', 'design-write', limits.designWriteMax, limits.windowMs) } }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const parsed = designSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_design', issues: parsed.error.flatten() });
    try { await assetStore.manifest(parsed.data.productId); } catch { return reply.code(404).send({ error: 'product_not_found' }); }
    return reply.code(201).send(await designs.upsert(parsed.data));
  });
  app.get<{ Params: { designId: string } }>('/v1/designs/:designId', { config: { rateLimit: rateLimitPolicy('wordpress', 'design-read', limits.designReadMax, limits.windowMs) } }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const record = await designs.get(request.params.designId);
    return record ?? reply.code(404).send({ error: 'design_not_found' });
  });
  app.post('/v1/paintsand/designs', { config: { rateLimit: rateLimitPolicy('paintsand', 'design-write', limits.designWriteMax, limits.windowMs) } }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const denied = verifyPaintsand(request, reply); if (denied) return denied;
    const parsed = designSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_design', issues: parsed.error.flatten() });
    try { await assetStore.manifest(parsed.data.productId); } catch { return reply.code(404).send({ error: 'product_not_found' }); }
    return reply.code(201).send(await paintsandDesigns.upsert(parsed.data));
  });
  app.get<{ Params: { designId: string } }>('/v1/paintsand/designs/:designId', { config: { rateLimit: rateLimitPolicy('paintsand', 'design-read', limits.designReadMax, limits.windowMs) } }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const denied = verifyPaintsand(request, reply); if (denied) return denied;
    const record = await paintsandDesigns.get(request.params.designId);
    return record ?? reply.code(404).send({ error: 'design_not_found' });
  });
  app.post('/v1/renders', { config: { rateLimit: rateLimitPolicy('wordpress', 'render', limits.renderMax, limits.windowMs) } }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const parsed = renderRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_render_request', issues: parsed.error.flatten() });
    return reply.code(501).send({
      error: 'renderer_not_configured',
      message: 'Manifest loading and design validation are ready. The local Vetrina-compatible renderer adapter is the next implementation step.'
    });
  });
  app.setErrorHandler((error, _request, reply) => {
    const statusCode = typeof error === 'object' && error && 'statusCode' in error ? Number(error.statusCode) : 500;
    if (statusCode === 429) {
      return reply.code(429).send({
        statusCode: 429,
        error: 'Too Many Requests',
        code: 'rate_limit_exceeded',
        message: error instanceof Error ? error.message : 'Rate limit exceeded'
      });
    }
    return reply.code(500).send({ error: 'internal_error', message: config.NODE_ENV === 'production' ? undefined : error instanceof Error ? error.message : String(error) });
  });
  return app;
}
