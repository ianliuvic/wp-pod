import crypto from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { RateLimitOptions } from '@fastify/rate-limit';

export type RateLimitSettings = {
  windowMs: number;
  productListMax: number;
  manifestMax: number;
  designReadMax: number;
  designWriteMax: number;
  renderMax: number;
};

type Site = 'paintsand' | 'shopify' | 'wordpress';
type Action = 'product-list' | 'manifest' | 'design-read' | 'design-write' | 'background-removal' | 'render';

function safeHeader(request: FastifyRequest, name: string): string {
  const value = request.headers[name];
  return typeof value === 'string' && value.length <= 160 ? value.trim() : '';
}

function shortHash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 24);
}

function actorKey(request: FastifyRequest, site: Site): string {
  if (site === 'paintsand') {
    const clientId = safeHeader(request, 'x-paintsand-client-id');
    if (clientId) return `client:${shortHash(clientId)}`;
  }
  if (site === 'shopify') {
    const query = request.query as Record<string, unknown>;
    const customerId = typeof query?.logged_in_customer_id === 'string' ? query.logged_in_customer_id.trim() : '';
    if (customerId) return `customer:${shortHash(customerId)}`;
  }
  return `ip:${request.ip}`;
}

export function rateLimitPolicy(site: Site, action: Action, max: number, windowMs: number): RateLimitOptions {
  return {
    max,
    timeWindow: windowMs,
    groupId: `${site}:${action}`,
    keyGenerator: (request) => actorKey(request, site),
    errorResponseBuilder: (_request, context) => ({
      statusCode: 429,
      error: 'Too Many Requests',
      code: 'rate_limit_exceeded',
      message: `Too many ${action.replace('-', ' ')} requests. Retry in ${context.after}.`,
      retryAfter: context.after
    })
  };
}
