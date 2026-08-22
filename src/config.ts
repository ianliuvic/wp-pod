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
  MONITORING_TOKEN: z.string().min(32).optional(),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_PRODUCT_LIST_MAX: z.coerce.number().int().positive().default(30),
  RATE_LIMIT_MANIFEST_MAX: z.coerce.number().int().positive().default(120),
  RATE_LIMIT_DESIGN_READ_MAX: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_DESIGN_WRITE_MAX: z.coerce.number().int().positive().default(20),
  RATE_LIMIT_RENDER_MAX: z.coerce.number().int().positive().default(10),
  SHOPIFY_API_SECRET: z.string().optional(),
  SHOPIFY_SHOP_DOMAIN: z.string().default('shop.wearhongxiu.com'),
  DATABASE_URL: z.string().url().optional()
});

const parsed = schema.parse(process.env);
export const config = {
  ...parsed,
  assetsRoot: path.resolve(parsed.POD_ASSETS_ROOT),
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
