import path from 'node:path';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(3000),
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:3000'),
  POD_ASSETS_ROOT: z.string().default('./pod-assets'),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),
  API_KEY: z.string().optional(),
  PAINTSAND_API_KEY: z.string().optional(),
  REPLICATE_API_TOKEN: z.string().optional(),
  DEEPSEEK_API_KEY: z.string().optional(),
  DEEPSEEK_BASE_URL: z.string().url().refine(value => value.startsWith('https://')).default('https://api.deepseek.com'),
  DEEPSEEK_MODEL: z.string().min(1).max(100).default('deepseek-flash'),
  MONITORING_TOKEN: z.string().min(32).optional(),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_PRODUCT_LIST_MAX: z.coerce.number().int().positive().default(30),
  RATE_LIMIT_MANIFEST_MAX: z.coerce.number().int().positive().default(120),
  RATE_LIMIT_DESIGN_READ_MAX: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_DESIGN_WRITE_MAX: z.coerce.number().int().positive().default(20),
  RATE_LIMIT_RENDER_MAX: z.coerce.number().int().positive().default(10),
  SHOPIFY_API_SECRET: z.string().optional(),
  /* Shopify webhook 的签名密钥：注册 webhook 的那个 app 的 client secret。
     与 app-proxy 用的 SHOPIFY_API_SECRET 不一定是同一个 app，所以单独配。 */
  SHOPIFY_WEBHOOK_SECRET: z.string().optional(),
  SHOPIFY_SHOP_DOMAIN: z.string().default('shop.wearhongxiu.com'),
  DATABASE_URL: z.string().url().optional(),
  // ── 服务端 mockup 渲染（客户端 WebGL 不可用时的兜底）──
  // 服务器无 GPU，靠 Chromium 自带的 SwiftShader 软件渲染。
  RENDER_ENABLED: z.enum(['true', 'false']).default('true'),
  CHROMIUM_PATH: z.string().optional(),
  RENDER_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(2),
  RENDER_QUEUE_LIMIT: z.coerce.number().int().min(0).max(200).default(24),
  RENDER_TIMEOUT_MS: z.coerce.number().int().min(5000).max(180000).default(45000),
  RENDER_CACHE_LIMIT: z.coerce.number().int().min(0).max(4096).default(96),
  // 单个页面渲染多少次后就回收换新页。复用太久引擎/WebGL 状态会退化，
  // 表现为渲染超时（实测跑一段时间后连 700px 都等满 45s）。
  RENDER_MAX_RENDERS_PER_PAGE: z.coerce.number().int().min(1).max(10000).default(25)
});

const parsed = schema.parse(process.env);
export const config = {
  ...parsed,
  assetsRoot: path.resolve(parsed.POD_ASSETS_ROOT),
  renderEnabled: parsed.RENDER_ENABLED === 'true',
  corsOrigins: parsed.CORS_ORIGINS.split(',').map((x) => x.trim()).filter(Boolean),
  rateLimits: {
    windowMs: parsed.RATE_LIMIT_WINDOW_MS,
    productListMax: parsed.RATE_LIMIT_PRODUCT_LIST_MAX,
    manifestMax: parsed.RATE_LIMIT_MANIFEST_MAX,
    designReadMax: parsed.RATE_LIMIT_DESIGN_READ_MAX,
    designWriteMax: parsed.RATE_LIMIT_DESIGN_WRITE_MAX,
    renderMax: parsed.RATE_LIMIT_RENDER_MAX
  }
};
