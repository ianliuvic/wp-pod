import fs from 'node:fs';
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
  await app.register(cors, { origin: (origin, cb) => cb(null, !origin || config.corsOrigins.includes(origin)) });
  if (fs.existsSync(assetsRoot)) await app.register(fastifyStatic, { root: assetsRoot, prefix: '/assets/', decorateReply: false });

  app.addHook('onRequest', async (request, reply) => {
    if (!config.API_KEY || request.url === '/health' || request.method === 'GET') return;
    if (request.headers['x-api-key'] !== config.API_KEY) return reply.code(401).send({ error: 'unauthorized' });
  });
  app.get('/health', async () => ({ status: 'ok', service: 'wp-pod', version: '0.1.0', assetsMounted: fs.existsSync(assetsRoot) }));
  app.get('/v1/products', async () => ({ products: await assetStore.listProducts() }));
  app.get<{ Params: { productId: string } }>('/v1/products/:productId/manifest', async (request, reply) => {
    try { return await assetStore.manifest(request.params.productId); }
    catch { return reply.code(404).send({ error: 'product_not_found' }); }
  });
  app.post('/v1/designs', async (request, reply) => {
    const parsed = designSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_design', issues: parsed.error.flatten() });
    try { await assetStore.manifest(parsed.data.productId); } catch { return reply.code(404).send({ error: 'product_not_found' }); }
    return reply.code(201).send(designs.create(parsed.data));
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
