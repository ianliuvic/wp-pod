import fs from 'node:fs/promises';
import path from 'node:path';

type CaptureSide = { id: string; name?: string; previewWidth?: number; previewHeight?: number; editorCanvas?: { width: number; height: number } };
type CaptureMode = { kind: 'all' | 'single'; templateName?: string; prototypeGroupId?: string; sides?: CaptureSide[]; viewIds?: string[] };
type Capture = { schemaVersion?: number; parentId: string; selectedProductId?: string; name?: string; detailUrl?: string; designUrl?: string; modes?: CaptureMode[] };
type NormalizedSide = { id: string; width?: number; height?: number };
type NormalizedMode = { name?: string; kind?: string; designSides?: NormalizedSide[] };
type Normalized = { modes?: NormalizedMode[] };

export class AssetStore {
  constructor(private readonly root: string, private readonly publicBaseUrl: string) {}

  private sceneViewCache = new Map<string, { id: string; previewUrl: string | null }[]>();

  private productsRoot() { return path.join(this.root, 'products'); }
  private productRoot(id: string) {
    if (!/^\d+$/.test(id)) throw new Error('Invalid product id');
    return path.join(this.productsRoot(), id);
  }
  private assetUrl(id: string, relative: string) {
    return `${this.publicBaseUrl.replace(/\/$/, '')}/assets/products/${id}/${relative.split(path.sep).map(encodeURIComponent).join('/')}`;
  }
  async listProducts() {
    const entries = await fs.readdir(this.productsRoot(), { withFileTypes: true });
    const products = await Promise.all(entries.filter((x) => x.isDirectory() && /^\d+$/.test(x.name)).map(async (x) => {
      try {
        const capture = await this.readCapture(x.name);
        return { id: x.name, designProductId: capture.selectedProductId ?? null, name: capture.name ?? x.name, modes: (capture.modes ?? []).map((m) => m.kind) };
      } catch { return null; }
    }));
    return products.filter(Boolean);
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
      const scene = JSON.parse(await fs.readFile(path.join(this.productRoot(id), 'pod', 'scenes', `${kind}.json`), 'utf8')) as Record<string, { psdFrames?: { F?: string }[] }>;
      result = viewIds.map((viewId) => {
        const frames = scene?.[viewId]?.psdFrames;
        const base = Array.isArray(frames) && frames.length ? frames[0] : null;
        const f = base && typeof base.F === 'string' ? base.F : '';
        const previewUrl = f ? this.assetUrl(id, path.join('pod', 'psdlayers', f.replace(/\.png$/, '_600.png'))) : null;
        return { id: viewId, previewUrl };
      });
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
      return {
        kind: mode.kind,
        templateName: mode.templateName ?? null,
        prototypeGroupId: mode.prototypeGroupId ?? null,
        viewIds: mode.viewIds ?? [],
        views,
        sceneUrl: this.assetUrl(id, path.join('pod', 'scenes', `${mode.kind}.json`)),
        sides: (mode.sides ?? []).map((side, index) => {
          const normalizedSide = normalizedMode?.designSides?.find((item) => String(item.id) === String(side.id));
          return {
            ...side,
            previewWidth: normalizedSide?.width ?? side.previewWidth,
            previewHeight: normalizedSide?.height ?? side.previewHeight,
            maskUrl: this.assetUrl(id, path.join('pod', 'masks', mode.kind, `${String(index + 1).padStart(2, '0')}_${side.id}.png`))
          };
        })
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
