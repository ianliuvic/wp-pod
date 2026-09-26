import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

type CaptureSide = { id: string; name?: string; previewWidth?: number; previewHeight?: number; editorCanvas?: { width: number; height: number } };
type CaptureMode = { kind: 'all' | 'single'; templateName?: string; prototypeGroupId?: string; sides?: CaptureSide[]; viewIds?: string[] };
type Capture = { schemaVersion?: number; parentId: string; selectedProductId?: string; name?: string; detailUrl?: string; designUrl?: string; modes?: CaptureMode[] };
type NormalizedSide = { id: string; width?: number; height?: number };
type NormalizedMode = { name?: string; kind?: string; designSides?: NormalizedSide[]; views?: Array<{ previewPath?: string | null }> };
type Normalized = { modes?: NormalizedMode[] };
type ProductRecord = { categoryMemberships?: Array<{ id?: string; label?: string }> };
export type ProductListEntry = {
  id: string;
  designProductId: string | null;
  name: string;
  modes: string[];
  categories: Array<{ id: string | null; label: string }>;
  thumbnailUrl: string | null;
};

export class AssetStore {
  constructor(private readonly root: string, private readonly publicBaseUrl: string) {}

  private sceneViewCache = new Map<string, { id: string; previewUrl: string | null }[]>();
  private assetVersionCache = new Map<string, { fingerprint: string; version: string }>();
  private productListCache: { at: number; items: ProductListEntry[] } | null = null;
  private static readonly PRODUCT_LIST_TTL_MS = 300_000;

  private productsRoot() { return path.join(this.root, 'products'); }
  private productRoot(id: string) {
    if (!/^\d+$/.test(id)) throw new Error('Invalid product id');
    return path.join(this.productsRoot(), id);
  }
  private assetUrl(id: string, relative: string) {
    const segments = relative.split(/[\\/]+/).filter(Boolean).map(encodeURIComponent);
    return `${this.publicBaseUrl.replace(/\/$/, '')}/assets/products/${id}/${segments.join('/')}`;
  }
  private async versionedAssetUrl(id: string, relative: string) {
    const absolute = path.join(this.productRoot(id), relative);
    try {
      const stat = await fs.stat(absolute);
      const fingerprint = `${stat.size}:${stat.mtimeMs}`;
      const cached = this.assetVersionCache.get(absolute);
      if (cached?.fingerprint === fingerprint) return `${this.assetUrl(id, relative)}?v=${cached.version}`;
      const version = crypto.createHash('sha256').update(await fs.readFile(absolute)).digest('hex').slice(0, 16);
      this.assetVersionCache.set(absolute, { fingerprint, version });
      return `${this.assetUrl(id, relative)}?v=${version}`;
    } catch {
      // Preserve the historical URL shape for incomplete archives so callers still
      // receive the same 404 instead of manifest generation failing altogether.
      return this.assetUrl(id, relative);
    }
  }
  /** Product catalogue with category memberships and a preview thumbnail. */
  async listProducts(): Promise<ProductListEntry[]> {
    const cached = this.productListCache;
    if (cached && Date.now() - cached.at < AssetStore.PRODUCT_LIST_TTL_MS) return cached.items;
    const entries = await fs.readdir(this.productsRoot(), { withFileTypes: true });
    const products = await Promise.all(
      entries.filter((x) => x.isDirectory() && /^\d+$/.test(x.name)).map((x) => this.buildProductEntry(x.name)),
    );
    const items = products.filter((item): item is ProductListEntry => Boolean(item));
    this.productListCache = { at: Date.now(), items };
    return items;
  }

  private async buildProductEntry(id: string): Promise<ProductListEntry | null> {
    try {
      const capture = await this.readCapture(id);
      const record = await this.readProductRecord(id);
      const normalized = await this.readNormalized(id);
      const categories = (record?.categoryMemberships ?? [])
        .map((membership) => ({ id: membership.id ?? null, label: String(membership.label ?? '').trim() }))
        .filter((membership) => membership.label.length > 0);
      const thumbnailUrl = await this.resolveThumbnailUrl(id, normalized);
      return {
        id,
        designProductId: capture.selectedProductId ?? null,
        name: capture.name ?? id,
        modes: (capture.modes ?? []).map((m) => m.kind),
        categories,
        thumbnailUrl,
      };
    } catch {
      return null;
    }
  }

  private async readProductRecord(id: string): Promise<ProductRecord | null> {
    try {
      return JSON.parse(await fs.readFile(path.join(this.productRoot(id), 'record.json'), 'utf8')) as ProductRecord;
    } catch {
      return null;
    }
  }

  private async readNormalized(id: string): Promise<Normalized | null> {
    try {
      return JSON.parse(await fs.readFile(path.join(this.productRoot(id), 'pod', 'normalized.json'), 'utf8')) as Normalized;
    } catch {
      return null;
    }
  }

  /** Prefer the archived default preview, then any file under pod/previews. */
  private async resolveThumbnailUrl(id: string, normalized: Normalized | null): Promise<string | null> {
    for (const mode of normalized?.modes ?? []) {
      const previewPath = mode.views?.find((view) => view.previewPath)?.previewPath;
      if (previewPath) return this.assetUrl(id, previewPath);
    }
    const fallback = await this.findPreviewFile(id);
    return fallback ? this.assetUrl(id, fallback) : null;
  }

  private async findPreviewFile(id: string): Promise<string | null> {
    try {
      const root = path.join(this.productRoot(id), 'pod', 'previews');
      const modes = await fs.readdir(root, { withFileTypes: true });
      for (const mode of modes) {
        if (!mode.isDirectory()) continue;
        const files = (await fs.readdir(path.join(root, mode.name))).filter((file) => /\.(png|webp|jpe?g)$/i.test(file)).sort();
        if (files.length) return path.join('pod', 'previews', mode.name, files[0]);
      }
    } catch {
      /* no previews archived for this product */
    }
    return null;
  }
  async readCapture(id: string): Promise<Capture> {
    return JSON.parse(await fs.readFile(path.join(this.productRoot(id), 'pod', 'capture.json'), 'utf8')) as Capture;
  }
  private async readViews(id: string, kind: string, viewIds: string[]): Promise<{ id: string; previewUrl: string | null }[]> {
    const cacheKey = `${id}:${kind}`;
    const cached = this.sceneViewCache.get(cacheKey);
    if (cached) return cached;
    let result: { id: string; previewUrl: string | null }[] = viewIds.map((viewId) => ({ id: viewId, previewUrl: null }));
    try {
      const scene = JSON.parse(await fs.readFile(path.join(this.productRoot(id), 'pod', 'scenes', `${kind}.json`), 'utf8')) as Record<string, { psdFrames?: Array<{ T?: string; N?: string; F?: string }> }>;
      result = await Promise.all(viewIds.map(async (viewId) => {
        const all = (scene?.[viewId]?.psdFrames ?? []).filter((frame) => typeof frame.F === 'string' && frame.F.length > 0);
        // A manifest preview is only a temporary placeholder until the live renderer
        // produces the composed scene. Prefer the model layer: schema/background-only
        // layers can look empty, and light Multiply artwork appears almost transparent
        // without the model beneath it.
        const model = all.filter((frame) => frame.T === 'model');
        const schema = all.find((frame) => frame.T === 'schema' || /背景|background/i.test(frame.N ?? ''));
        const raster = all.filter((frame) => (frame.T ?? 'Raster') === 'Raster');
        const candidates = raster.filter((frame) => !/highlight|shadow|高光|阴影/i.test(frame.N ?? ''));
        const pool = model.length ? model : (schema ? [schema] : (candidates.length ? candidates : (raster.length ? raster : all)));
        let best: { F?: string } | null = null;
        let bestSize = -1;
        for (const frame of pool) {
          try {
            const filename = (frame.F as string).replace(/\.png$/, '_600.png');
            const stat = await fs.stat(path.join(this.productRoot(id), 'pod', 'psdlayers', filename));
            if (stat.size > bestSize) { bestSize = stat.size; best = frame; }
          } catch {}
        }
        const f = best && typeof best.F === 'string' ? best.F : '';
        const previewUrl = f ? await this.versionedAssetUrl(id, path.join('pod', 'psdlayers', f.replace(/\.png$/, '_600.png'))) : null;
        return { id: viewId, previewUrl };
      }));
    } catch {}
    this.sceneViewCache.set(cacheKey, result);
    return result;
  }

  async manifest(id: string) {
    const capture = await this.readCapture(id);
    let normalized: Normalized | null = null;
    try { normalized = JSON.parse(await fs.readFile(path.join(this.productRoot(id), 'pod', 'normalized.json'), 'utf8')) as Normalized; } catch {}
    const modes = await Promise.all((capture.modes ?? []).map(async (mode) => {
      const normalizedMode = normalized?.modes?.find((item) => (item.kind ?? item.name) === mode.kind);
      const views = await this.readViews(id, mode.kind, mode.viewIds ?? []);
      const sceneUrl = await this.versionedAssetUrl(id, path.join('pod', 'scenes', `${mode.kind}.json`));
      const sides = await Promise.all((mode.sides ?? []).map(async (side, index) => {
        const normalizedSide = normalizedMode?.designSides?.find((item) => String(item.id) === String(side.id));
        return {
          ...side,
          previewWidth: normalizedSide?.width ?? side.previewWidth,
          previewHeight: normalizedSide?.height ?? side.previewHeight,
          maskUrl: await this.versionedAssetUrl(id, path.join('pod', 'masks', mode.kind, `${String(index + 1).padStart(2, '0')}_${side.id}.png`))
        };
      }));
      return {
        kind: mode.kind,
        templateName: mode.templateName ?? null,
        prototypeGroupId: mode.prototypeGroupId ?? null,
        viewIds: mode.viewIds ?? [],
        views,
        sceneUrl,
        sides
      };
    }));
    return {
      schemaVersion: 1,
      productId: id,
      designProductId: capture.selectedProductId ?? null,
      name: capture.name ?? id,
      source: { detailUrl: capture.detailUrl ?? null, designUrl: capture.designUrl ?? null },
      modes
    };
  }
}
