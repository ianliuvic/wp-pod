import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { FastifyReply } from 'fastify';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { config } from './config.js';
import { AssetStore } from './asset-store.js';
import { DesignStore } from './design-store.js';
import { designSchema, renderRequestSchema } from './schemas.js';

export async function buildApp(options: { assetsRoot?: string; publicBaseUrl?: string } = {}) {
  const app = Fastify({ logger: config.NODE_ENV !== 'test' });
  const assetsRoot = options.assetsRoot ?? config.assetsRoot;
  const assetStore = new AssetStore(assetsRoot, options.publicBaseUrl ?? config.PUBLIC_BASE_URL);
  const designs = new DesignStore();
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
  await app.register(cors, { origin: (origin, cb) => cb(null, !origin || config.corsOrigins.includes(origin)) });
    function setCacheHeaders(reply: FastifyReply, filePath: string): void {
    const ext = path.extname(filePath).toLowerCase();
    if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.avif', '.ico'].includes(ext)) {
      reply.header('Cache-Control', 'public, max-age=31536000, immutable');
    } else {
      reply.header('Cache-Control', 'public, max-age=3600');
    }
  }
  if (fs.existsSync(assetsRoot)) await app.register(fastifyStatic, { root: assetsRoot, prefix: '/assets/', decorateReply: false, setHeaders: setCacheHeaders });
  const vendorRoot = path.resolve('public/vendor');
  if (fs.existsSync(vendorRoot)) await app.register(fastifyStatic, { root: vendorRoot, prefix: '/vendor/', decorateReply: false, setHeaders: setCacheHeaders });

  app.addHook('onRequest', async (request, reply) => {
    if (request.url.startsWith('/v1/shopify/') || !config.API_KEY || request.url === '/health' || request.method === 'GET') return;
    if (request.headers['x-api-key'] !== config.API_KEY) return reply.code(401).send({ error: 'unauthorized' });
  });
  app.get('/health', async () => ({ status: 'ok', service: 'wp-pod', version: '0.1.0', assetsMounted: fs.existsSync(assetsRoot) }));
  app.get('/v1/products', async () => ({ products: await assetStore.listProducts() }));
  app.get<{ Querystring: Record<string, unknown>; Params: { productId: string } }>('/v1/shopify/manifest/:productId', async (request, reply) => {
    const denied = verifyShopifyProxy(request, reply); if (denied) return denied;
    try { return await assetStore.manifest(request.params.productId); } catch { return reply.code(404).send({ error: 'product_not_found' }); }
  });
  app.post<{ Querystring: Record<string, unknown> }>('/v1/shopify/designs', async (request, reply) => {
    const denied = verifyShopifyProxy(request, reply); if (denied) return denied;
    const parsed = designSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_design', issues: parsed.error.flatten() });
    try { await assetStore.manifest(parsed.data.productId); } catch { return reply.code(404).send({ error: 'product_not_found' }); }
    return reply.code(201).send(designs.upsert(parsed.data));
  });
  app.get<{ Params: { productId: string } }>('/v1/products/:productId/manifest', async (request, reply) => {
    try { return await assetStore.manifest(request.params.productId); }
    catch { return reply.code(404).send({ error: 'product_not_found' }); }
  });
  app.post('/v1/designs', async (request, reply) => {
    const parsed = designSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_design', issues: parsed.error.flatten() });
    try { await assetStore.manifest(parsed.data.productId); } catch { return reply.code(404).send({ error: 'product_not_found' }); }
    return reply.code(201).send(designs.upsert(parsed.data));
  });
  app.get<{ Params: { designId: string } }>('/v1/designs/:designId', async (request, reply) => {
    const record = designs.get(request.params.designId);
    return record ?? reply.code(404).send({ error: 'design_not_found' });
  });
  app.post('/v1/renders', async (request, reply) => {
    const parsed = renderRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_render_request', issues: parsed.error.flatten() });
    return reply.code(501).send({
      error: 'renderer_not_configured',
      message: 'Manifest loading and design validation are ready. The local Vetrina-compatible renderer adapter is the next implementation step.'
    });
  });
  app.setErrorHandler((error, _request, reply) => reply.code(500).send({ error: 'internal_error', message: config.NODE_ENV === 'production' ? undefined : error instanceof Error ? error.message : String(error) }));
  return app;
}
