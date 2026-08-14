import fs from 'node:fs/promises';
import path from 'node:path';

type CaptureSide = { id: string; name?: string; previewWidth?: number; previewHeight?: number; editorCanvas?: { width: number; height: number } };
type CaptureMode = { kind: 'all' | 'single'; templateName?: string; prototypeGroupId?: string; sides?: CaptureSide[]; viewIds?: string[] };
type Capture = { schemaVersion?: number; parentId: string; selectedProductId?: string; name?: string; detailUrl?: string; designUrl?: string; modes?: CaptureMode[] };

export class AssetStore {
  constructor(private readonly root: string, private readonly publicBaseUrl: string) {}

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
  async manifest(id: string) {
    const capture = await this.readCapture(id);
    const modes = await Promise.all((capture.modes ?? []).map(async (mode) => {
      const sceneFile = path.join(this.productRoot(id), 'pod', 'scenes', `${mode.kind}.json`);
      let scene: unknown = null;
      try { scene = JSON.parse(await fs.readFile(sceneFile, 'utf8')); } catch {}
      return {
        kind: mode.kind,
        templateName: mode.templateName ?? null,
        prototypeGroupId: mode.prototypeGroupId ?? null,
        viewIds: mode.viewIds ?? [],
        scene,
        sides: (mode.sides ?? []).map((side, index) => ({
          ...side,
          maskUrl: this.assetUrl(id, path.join('pod', 'masks', mode.kind, `${String(index + 1).padStart(2, '0')}_${side.id}.png`))
        }))
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
