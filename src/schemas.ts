import { z } from 'zod';

export const layerSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['image', 'text']),
  modeKind: z.enum(['all', 'single']).optional(),
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
  tile: z.enum(['none', 'basic', 'brick-x', 'brick-y', 'random', 'half-drop', 'half-brick', 'mirror']).optional(),
  tileSize: z.number().positive().max(1000).optional(),
  tileGap: z.number().min(0).max(100).optional(),
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
  modeKind: z.enum(['all', 'single']).optional(),
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

/**
 * 服务端 mockup 预览请求。
 * 客户端 WebGL 不可用时，把当前设计的「压平设计面」（surfaceData 输出的 WebP dataURL）
 * 直接交给服务器，由服务器代跑 SDS 引擎出图。
 * 字段与客户端 postMessage 给引擎的参数一一对应。
 */
export const renderPreviewSchema = z.object({
  productId: z.string().regex(/^\d+$/),
  modeKind: z.enum(['all', 'single']),
  viewId: z.string().min(1).max(80),
  sceneUrl: z.string().url().max(2000),
  cdnPrefix: z.string().url().max(2000),
  sides: z
    .array(
      z.object({
        id: z.string().min(1).max(120),
        name: z.string().max(200).optional(),
        width: z.number().positive().max(4000),
        height: z.number().positive().max(4000)
      })
    )
    .min(1)
    .max(40),
  surfaces: z
    .array(
      z.object({
        sideId: z.string().min(1).max(120),
        surface: z.string().startsWith('data:image/').max(6_000_000),
        width: z.number().positive().max(4000),
        height: z.number().positive().max(4000)
      })
    )
    .min(1)
    .max(40),
  outputSize: z.number().int().min(200).max(1400).default(700)
});
export type RenderPreview = z.infer<typeof renderPreviewSchema>;
export type Design = z.infer<typeof designSchema>;
