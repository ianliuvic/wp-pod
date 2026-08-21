import { z } from 'zod';

export const layerSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['image', 'text']),
  sideId: z.string().min(1),
  sourceUrl: z.string().url().optional(),
  src: z.string().url().optional(),
  name: z.string().max(500).optional(),
  source: z.string().max(100).optional(),
  text: z.string().max(500).optional(),
  x: z.number(), y: z.number(),
  scaleX: z.number(), scaleY: z.number(),
  rotation: z.number(), opacity: z.number().min(0).max(1),
  zIndex: z.number().int(),
  style: z.record(z.unknown()).optional(),
  boxW: z.number().positive().max(1000).optional(),
  boxH: z.number().positive().max(1000).nullable().optional(),
  fit: z.enum(['contain', 'cover', 'fill', 'stretch', 'tile']).optional(),
  imageMode: z.enum(['custom', 'fit', 'fill', 'stretch', 'tile']).optional(),
  tile: z.enum(['none', 'basic', 'half-drop', 'half-brick', 'mirror']).optional(),
  tileSize: z.number().positive().max(1000).optional(),
  crop: z.record(z.unknown()).nullable().optional(),
  filter: z.string().max(100).optional(),
  filterValue: z.number().optional()
});

export const exportedSurfaceSchema = z.object({
  sideId: z.string().min(1),
  name: z.string().max(500).optional(),
  url: z.string().url(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  format: z.string().max(32).optional()
});

export const designSchema = z.object({
  id: z.string().uuid().optional(),
  schemaVersion: z.literal(1),
  productId: z.string().regex(/^\d+$/),
  mode: z.enum(['all', 'single']),
  background: z.string().regex(/^#[0-9a-f]{6}$/i).nullable().default(null),
  backgrounds: z.record(z.string().regex(/^#[0-9a-f]{6}$/i)).default({}),
  layers: z.array(layerSchema).max(200),
  quantities: z.record(z.number().int().min(0).max(999)).default({}),
  previews: z.array(z.string().url()).max(20).optional(),
  surfaces: z.array(exportedSurfaceSchema).max(100).optional(),
  automation: z.object({
    jobId: z.string().max(200).optional(),
    requestedAt: z.string().datetime().optional(),
    planVersion: z.number().int().positive().optional()
  }).optional()
});

export const renderRequestSchema = z.object({
  design: designSchema,
  viewIds: z.array(z.string()).optional()
});
export type Design = z.infer<typeof designSchema>;
