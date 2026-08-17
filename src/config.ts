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
  SHOPIFY_API_SECRET: z.string().optional(),
  SHOPIFY_SHOP_DOMAIN: z.string().default('shop.wearhongxiu.com')
});

const parsed = schema.parse(process.env);
export const config = {
  ...parsed,
  assetsRoot: path.resolve(parsed.POD_ASSETS_ROOT),
  corsOrigins: parsed.CORS_ORIGINS.split(',').map((x) => x.trim()).filter(Boolean)
};
