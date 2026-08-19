import { z } from 'zod';

export const layerSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['image', 'text']),
  sideId: z.string().min(1),
  sourceUrl: z.string().url().optional(),
  text: z.string().max(500).optional(),
  x: z.number(), y: z.number(),
  scaleX: z.number(), scaleY: z.number(),
  rotation: z.number(), opacity: z.number().min(0).max(1),
  zIndex: z.number().int(),
  style: z.record(z.unknown()).optional()
});

export const designSchema = z.object({
  id: z.string().uuid().optional(),
  schemaVersion: z.literal(1),
  productId: z.string().regex(/^\d+$/),
  mode: z.enum(['all', 'single']),
  background: z.string().regex(/^#[0-9a-f]{6}$/i).nullable().default(null),
  layers: z.array(layerSchema).max(200),
  quantities: z.record(z.number().int().min(0).max(999)).default({}),
  previews: z.array(z.string().url()).max(20).optional()
});

export const renderRequestSchema = z.object({
  design: designSchema,
  viewIds: z.array(z.string()).optional()
});
export type Design = z.infer<typeof designSchema>;
