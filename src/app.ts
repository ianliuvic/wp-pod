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
import { IntakeStore } from './intake-store.js';
import { designSchema, renderRequestSchema, renderPreviewSchema, intakeSchema, intakeOrderSchema, intakeSdsSchema } from './schemas.js';
import { intakeOpsPage } from './ops-page.js';
import { MonitoringCollector } from './monitoring.js';
import { rateLimitPolicy, type RateLimitSettings } from './rate-limits.js';
import { removeImageBackground } from './background-removal.js';
import { MockupRenderer } from './renderer.js';

const backgroundRemovalRequestSchema = z.object({
  image: z.string().max(8_000_000).refine((value) => /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(value) || /^https:\/\//.test(value))
});

const internalDesignListQuerySchema = z.object({
  since: z.string().datetime({ offset: true }),
  until: z.string().datetime({ offset: true }),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
}).refine((query) => Date.parse(query.since) < Date.parse(query.until), {
  message: 'since must be earlier than until',
  path: ['since'],
});

export async function buildApp(options: { assetsRoot?: string; publicBaseUrl?: string; paintsandApiKey?: string; monitoringToken?: string; rateLimits?: Partial<RateLimitSettings>; replicateApiToken?: string } = {}) {
  const app = Fastify({ logger: config.NODE_ENV !== 'test', trustProxy: ['loopback', 'linklocal', 'uniquelocal'] });
  const monitoring = new MonitoringCollector();
  const requestStartedAt = new WeakMap<object, bigint>();
  const assetsRoot = options.assetsRoot ?? config.assetsRoot;
  const assetStore = new AssetStore(assetsRoot, options.publicBaseUrl ?? config.PUBLIC_BASE_URL);
  const designs = new DesignStore(config.DATABASE_URL, 'designs');
  const paintsandDesigns = new DesignStore(config.DATABASE_URL, 'paintsand_designs');
  const intakes = new IntakeStore(config.DATABASE_URL, options.publicBaseUrl ?? config.PUBLIC_BASE_URL);
  await designs.init();
  await paintsandDesigns.init();
  await intakes.init();
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
  function verifyMonitoring(request: { headers: Record<string, unknown> }, reply: { code: (status: number) => { send: (body: unknown) => unknown } }) {
    if (!monitoringToken) return reply.code(503).send({ error: 'monitoring_not_configured' });
    const supplied = typeof request.headers.authorization === 'string' ? request.headers.authorization : '';
    const expected = Buffer.from(`Bearer ${monitoringToken}`);
    const received = Buffer.from(supplied);
    if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) return reply.code(401).send({ error: 'unauthorized' });
    return null;
  }
  // 服务端 mockup 渲染器：懒加载，第一次真正需要时才启动 Chromium
  let rendererInstance: MockupRenderer | null = null;
  function getRenderer(): MockupRenderer {
    if (!rendererInstance) {
      rendererInstance = new MockupRenderer({
        localOrigin: `http://127.0.0.1:${config.PORT}`,
        executablePath: config.CHROMIUM_PATH,
        concurrency: config.RENDER_MAX_CONCURRENCY,
        queueLimit: config.RENDER_QUEUE_LIMIT,
        renderTimeoutMs: config.RENDER_TIMEOUT_MS,
        cacheLimit: config.RENDER_CACHE_LIMIT,
        maxRendersPerPage: config.RENDER_MAX_RENDERS_PER_PAGE,
        log: app.log
      });
      app.log.info(
        { concurrency: config.RENDER_MAX_CONCURRENCY, queueLimit: config.RENDER_QUEUE_LIMIT, timeoutMs: config.RENDER_TIMEOUT_MS, maxRendersPerPage: config.RENDER_MAX_RENDERS_PER_PAGE },
        'server-side mockup renderer enabled'
      );
    }
    return rendererInstance;
  }
  app.addHook('onClose', async () => {
    if (rendererInstance) await rendererInstance.close();
  });

  /** 服务端 mockup 预览：客户端 WebGL 不可用时由服务器代跑 SDS 引擎 */
  async function handlePreviewRender(
    body: unknown,
    log: { warn: (obj: unknown, msg: string) => void },
    reply: { code: (n: number) => { send: (b: unknown) => unknown }; send: (b: unknown) => unknown }
  ) {
    const preview = renderPreviewSchema.safeParse(body);
    if (!preview.success) {
      return reply.code(400).send({ error: 'invalid_render_preview', issues: preview.error.flatten() });
    }
    if (!config.renderEnabled) {
      return reply.code(503).send({ error: 'render_disabled', message: 'server-side rendering is disabled' });
    }
    const startedAt = Date.now();
    try {
      const image = await getRenderer().render({
        sceneUrl: preview.data.sceneUrl,
        viewId: preview.data.viewId,
        cdnPrefix: preview.data.cdnPrefix,
        sides: preview.data.sides,
        surfaces: preview.data.surfaces,
        outputSize: preview.data.outputSize
      });
      return reply.send({ image, outputSize: preview.data.outputSize, elapsedMs: Date.now() - startedAt });
    } catch (error) {
      log.warn({ err: error }, 'server-side mockup render failed');
      const message = error instanceof Error ? error.message : 'render_failed';
      const overloaded = message === 'renderer_overloaded';
      return reply.code(overloaded ? 503 : 502).send({ error: overloaded ? 'renderer_overloaded' : 'render_failed', message });
    }
  }
  await app.register(cors, { origin: (origin, cb) => cb(null, !origin || config.corsOrigins.includes(origin)) });
  await app.register(fastifyRateLimit, { global: false });
  /* 保留原始 JSON 文本：Shopify webhook 的 HMAC 要用原始 body 算 */
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    (request as unknown as { rawBody?: string }).rawBody = body as string;
    try { done(null, JSON.parse(body as string)); }
    catch (error) { (error as { statusCode?: number }).statusCode = 400; done(error as Error, undefined); }
  });
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
  if (fs.existsSync(vendorRoot)) await app.register(fastifyStatic, { root: vendorRoot, prefix: '/vendor/', decorateReply: false, preCompressed: true, setHeaders: setVendorCacheHeaders });

  // ── 素材缩略图：GET /thumbs/<相对路径>?w=96[&v=版本] ─────────────────────────
  // 用途：替代「拿 1200x1200 原图当 40px 列表缩略图」的浪费 —— 下载从每张 20~77KB
  // 降到约 1~3KB，解码位图从 5.5MB 降到几十 KB。原始 /assets/ 路径完全不变，
  // 画布仍用全尺寸遮罩；sharp 不可用或处理失败时 302 回退到原图（行为等同改造前）。
  const thumbCache = new Map<string, Buffer>();
  let sharpModule: ((input: string) => any) | null | undefined;
  app.get('/thumbs/*', async (request, reply) => {
    const relative = decodeURIComponent(String((request.params as Record<string, string>)['*'] ?? ''));
    const query = request.query as Record<string, unknown>;
    const requested = Number(query.w);
    const width = Number.isFinite(requested) ? Math.min(512, Math.max(16, Math.round(requested))) : 96;
    const rootResolved = path.resolve(assetsRoot);
    const absolute = path.resolve(rootResolved, relative);
    if (absolute !== rootResolved && !absolute.startsWith(rootResolved + path.sep)) {
      return reply.code(400).send({ error: 'invalid path' });
    }
    if (!/\.(png|jpe?g|webp)$/i.test(absolute)) return reply.code(400).send({ error: 'unsupported type' });
    const fallback = `/assets/${relative.split('/').map(encodeURIComponent).join('/')}`;

    const key = `${absolute}@${width}@${String(query.v ?? '')}`;
    const cached = thumbCache.get(key);
    if (cached) {
      return reply.header('Cache-Control', 'public, max-age=31536000, immutable').type('image/webp').send(cached);
    }
    if (sharpModule === undefined) {
      try {
        const mod = await import('sharp');
        sharpModule = ((mod as any).default ?? mod) as (input: string) => any;
      } catch (error) {
        app.log.warn({ err: error }, 'sharp unavailable; /thumbs falls back to originals');
        sharpModule = null;
      }
    }
    if (!sharpModule) return reply.redirect(fallback);
    try {
      const buffer = await sharpModule(absolute)
        .resize(width, width, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 82 })
        .toBuffer();
      if (thumbCache.size >= 1024) thumbCache.clear();
      thumbCache.set(key, buffer);
      return reply.header('Cache-Control', 'public, max-age=31536000, immutable').type('image/webp').send(buffer);
    } catch (error) {
      app.log.warn({ err: error, absolute }, 'thumbnail generation failed; falling back to original');
      return reply.redirect(fallback);
    }
  });

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
    return {
      status: 'ok',
      service: 'wp-pod',
      version: '0.1.0',
      assetsMounted: fs.existsSync(assetsRoot),
      renderer: config.renderEnabled ? (rendererInstance ? rendererInstance.stats() : 'idle') : 'disabled'
    };
  });
  app.get('/internal/metrics', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const denied = verifyMonitoring(request, reply); if (denied) return denied;
    return monitoring.snapshot(fs.existsSync(assetsRoot) ? assetsRoot : process.cwd());
  });
  app.get<{ Querystring: Record<string, unknown> }>('/internal/designs', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const denied = verifyMonitoring(request, reply); if (denied) return denied;
    const parsed = internalDesignListQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_query', issues: parsed.error.flatten() });
    const { since, until, limit, offset } = parsed.data;
    const page = await designs.listCreatedBetween(new Date(since), new Date(until), limit, offset);
    return {
      since,
      until,
      count: page.designs.length,
      total: page.total,
      limit,
      offset,
      hasMore: offset + page.designs.length < page.total,
      designs: page.designs,
    };
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
  // 客户端 WebGL 不可用时的兜底：由服务器代跑 SDS 引擎出图。
  // 走 App Proxy（/apps/pod-api/renders → /v1/shopify/renders），用签名校验，
  // 不设 rate-limit —— 真流量保护由渲染器自身的并发槽位 + 队列上限 + 缓存承担。
  app.post<{ Querystring: Record<string, unknown> }>(
    '/v1/shopify/renders',
    { bodyLimit: 12 * 1024 * 1024 },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const denied = verifyShopifyProxy(request, reply);
      if (denied) return denied;
      return handlePreviewRender(request.body, request.log, reply);
    }
  );
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
  app.post(
    '/v1/renders',
    // 请求体会带若干张压平设计面（WebP dataURL），默认 1MB 不够
    { bodyLimit: 12 * 1024 * 1024 },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      // 优先走「压平设计面」预览路径；失败再落到旧的按设计稿渲染路径
      const preview = renderPreviewSchema.safeParse(request.body);
      if (preview.success) {
        return handlePreviewRender(request.body, request.log, reply);
      }
      const parsed = renderRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_render_request', issues: preview.error.flatten() });
      }
      return reply.code(501).send({
        error: 'renderer_not_configured',
        message: 'The design-payload render path is not implemented yet. Use the surfaces preview payload instead.'
      });
    }
  );
  /* ---------- POD 设计拍平输入（intakes）：保存 / 订单绑定 / SDS 队列 -------------- */
  app.post<{ Body: unknown }>('/v1/intakes', { bodyLimit: 16_000_000, config: { rateLimit: rateLimitPolicy('wordpress', 'intake-write', limits.designWriteMax, limits.windowMs) } }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const parsed = intakeSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_intake', issues: parsed.error.flatten() });
    try { await assetStore.manifest(parsed.data.productId); } catch { return reply.code(404).send({ error: 'product_not_found' }); }
    const record = await intakes.create({
      designId: parsed.data.designId ?? null,
      productId: parsed.data.productId,
      productName: parsed.data.productName ?? null,
      modeKind: parsed.data.mode.kind,
      templateName: parsed.data.mode.templateName ?? null,
      shopifyDomain: parsed.data.shopifyDomain ?? null,
      source: parsed.data.source ?? null,
      sides: parsed.data.sides,
      design: parsed.data.design,
      meta: parsed.data.meta
    });
    return reply.code(201).send(record);
  });
  app.post<{ Querystring: Record<string, unknown>; Body: unknown }>('/v1/shopify/intakes', { bodyLimit: 16_000_000, config: { rateLimit: rateLimitPolicy('shopify', 'intake-write', limits.designWriteMax, limits.windowMs) } }, async (request, reply) => {
    const denied = verifyShopifyProxy(request, reply); if (denied) return denied;
    reply.header('Cache-Control', 'no-store');
    const parsed = intakeSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_intake', issues: parsed.error.flatten() });
    try { await assetStore.manifest(parsed.data.productId); } catch { return reply.code(404).send({ error: 'product_not_found' }); }
    return reply.code(201).send(await intakes.create({
      designId: parsed.data.designId ?? null,
      productId: parsed.data.productId,
      productName: parsed.data.productName ?? null,
      modeKind: parsed.data.mode.kind,
      templateName: parsed.data.mode.templateName ?? null,
      shopifyDomain: parsed.data.shopifyDomain ?? null,
      source: parsed.data.source ?? 'designer_live',
      sides: parsed.data.sides,
      design: parsed.data.design,
      meta: parsed.data.meta
    }));
  });
  app.get<{ Querystring: { status?: string; date?: string; productId?: string; limit?: string; offset?: string } }>('/v1/intakes', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const query = request.query ?? {};
    return intakes.list({
      status: query.status || null,
      date: query.date || null,
      productId: query.productId || null,
      limit: query.limit ? Number(query.limit) : 50,
      offset: query.offset ? Number(query.offset) : 0
    });
  });
  app.get<{ Querystring: { days?: string; date?: string } }>('/v1/intakes/stats', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const query = request.query ?? {};
    const stats = await intakes.stats({ days: query.days ? Number(query.days) : 14, date: query.date || null });
    return Object.assign({ persistent: intakes.persistent, generatedAt: new Date().toISOString() }, stats);
  });
  app.get<{ Params: { intakeId: string } }>('/v1/intakes/:intakeId', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const record = await intakes.get(request.params.intakeId);
    return record ?? reply.code(404).send({ error: 'intake_not_found' });
  });
  app.get<{ Params: { intakeId: string; sideId: string } }>('/v1/intakes/:intakeId/sides/:sideId', async (request, reply) => {
    const sideId = request.params.sideId.replace(/\.png$/i, '');
    const side = await intakes.sideBytes(request.params.intakeId, sideId);
    if (!side) return reply.code(404).send({ error: 'intake_side_not_found' });
    reply.header('Content-Type', side.mime);
    reply.header('Cache-Control', 'public, max-age=31536000, immutable');
    return reply.send(side.bytes);
  });
  app.post<{ Params: { intakeId: string }; Body: unknown }>('/v1/intakes/:intakeId/orders', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const parsed = intakeOrderSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_intake_order', issues: parsed.error.flatten() });
    const order = await intakes.addOrder(request.params.intakeId, parsed.data);
    if (!order) return reply.code(404).send({ error: 'intake_not_found' });
    return reply.code(201).send(order);
  });
  app.post<{ Params: { intakeId: string }; Body: unknown }>('/v1/intakes/:intakeId/sds', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const parsed = intakeSdsSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_sds_patch', issues: parsed.error.flatten() });
    const record = await intakes.setSds(request.params.intakeId, parsed.data);
    if (!record) return reply.code(404).send({ error: 'intake_not_found' });
    return record;
  });
  /* 真实购买回写：Shopify orders/create（或 orders/paid）webhook。
     线路已接好（HMAC 校验 + 按 line item properties 里的 _pod_intake_id 绑定尺码/数量），
     等真的要上线时再到 Shopify 注册 webhook 即可；测试阶段用 POST /v1/intakes/:id/orders 模拟。 */
  app.post<{ Body: { id?: number | string; name?: string; line_items?: Array<Record<string, unknown>> } }>('/v1/shopify/orders-webhook', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!config.SHOPIFY_API_SECRET) return reply.code(503).send({ error: 'shopify_webhook_not_configured' });
    const supplied = typeof request.headers['x-shopify-hmac-sha256'] === 'string' ? request.headers['x-shopify-hmac-sha256'] : '';
    const rawBody = (request as unknown as { rawBody?: string }).rawBody ?? '';
    if (!supplied || !rawBody) return reply.code(401).send({ error: 'missing_webhook_hmac' });
    const expected = crypto.createHmac('sha256', config.SHOPIFY_API_SECRET).update(rawBody, 'utf8').digest('base64');
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
      return reply.code(401).send({ error: 'invalid_webhook_hmac' });
    }
    const order = request.body ?? {};
    let bound = 0;
    const skipped: string[] = [];
    for (const line of order.line_items ?? []) {
      const properties = Array.isArray(line.properties) ? (line.properties as Array<{ name?: string; value?: string }>) : [];
      const pick = (needle: string) => properties.find((item) => String(item?.name ?? '').toLowerCase() === needle)?.value ?? null;
      const intakeId = pick('_pod_intake_id');
      const designId = pick('_pod_design_id');
      const size = pick('size') ?? (typeof line.variant_title === 'string' ? line.variant_title : null);
      const quantity = Number(line.quantity) || 0;
      const target = intakeId ? intakeId : designId ? (await intakes.getByDesignId(designId))?.id ?? null : null;
      if (!target) { skipped.push(String(line.id ?? '')); continue; }
      const created = await intakes.addOrder(target, {
        size,
        quantity,
        orderId: order.id == null ? null : String(order.id),
        orderName: order.name ?? null,
        variantId: line.variant_id == null ? null : String(line.variant_id),
        lineItemId: line.id == null ? null : String(line.id),
        source: 'webhook',
        raw: { properties }
      });
      if (created) bound += 1;
    }
    return { bound, skipped };
  });
  app.get('/ops/intakes', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('Content-Type', 'text/html; charset=utf-8');
    return intakeOpsPage();
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
