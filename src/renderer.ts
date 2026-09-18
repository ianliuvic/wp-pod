import { createHash } from 'node:crypto';
import fs from 'node:fs';
import type { FastifyBaseLogger } from 'fastify';

/**
 * 服务端 mockup 渲染器。
 *
 * 用途：客户端 WebGL 不可用时（iOS WebKit 没有软件渲染兜底，GPU 一旦异常 WebGL 直接失效），
 * 由服务器代跑 SDS 引擎出图。服务器没有 GPU，靠 Chromium 自带的 SwiftShader 软件渲染，
 * 实测单张约 400ms（20 线程），4 vCPU 预计 1~2 秒。
 *
 * 关键点：这里运行的是 SDS 的引擎本体（renderer-frame.html + sds-*.js），
 * 不是重新实现合成算法 —— 所以输出与客户端完全一致，不存在算法偏差。
 */

export type RenderSide = { id: string; name?: string; width: number; height: number };
export type RenderSurface = { sideId: string; surface: string; width: number; height: number };

export type RenderJob = {
  sceneUrl: string;
  viewId: string;
  cdnPrefix: string;
  sides: RenderSide[];
  surfaces: RenderSurface[];
  outputSize: number;
};

type PoolEntry = {
  page: import('puppeteer-core').Page;
  busy: boolean;
  frameReady: boolean;
  renders: number;
};

const RENDERER_FRAME_PATH = '/vendor/v3/renderer-frame.html?v=20260824-model-1';

/** 常见发行版的 Chromium 可执行文件位置 */
const CHROMIUM_CANDIDATES = [
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/local/bin/chromium'
];

function detectChromium(explicit?: string): string | undefined {
  if (explicit && fs.existsSync(explicit)) return explicit;
  for (const candidate of CHROMIUM_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return explicit;
}

/** 把公网地址换成本机地址，省掉一次出网往返 */
function toLocal(url: string, localOrigin: string): string {
  return url.startsWith('https://pod-api.wearhongxiu.com/')
    ? localOrigin + '/' + url.slice('https://pod-api.wearhongxiu.com/'.length)
    : url;
}

export class MockupRenderer {
  private browser: import('puppeteer-core').Browser | null = null;
  private launching: Promise<import('puppeteer-core').Browser> | null = null;
  private pool: PoolEntry[] = [];
  private waiters: Array<() => void> = [];
  private cache = new Map<string, string>();
  private disposed = false;
  private inflight = 0;

  constructor(
    private readonly opts: {
      localOrigin: string;
      executablePath?: string;
      concurrency: number;
      queueLimit: number;
      renderTimeoutMs: number;
      cacheLimit: number;
      log: FastifyBaseLogger;
    }
  ) {}

  stats() {
    return {
      browser: this.browser && this.browser.connected ? 'up' : 'down',
      poolSize: this.pool.length,
      busy: this.pool.filter((p) => p.busy).length,
      waiting: this.waiters.length,
      inflight: this.inflight,
      cache: this.cache.size
    };
  }

  private async ensureBrowser() {
    if (this.browser && this.browser.connected) return this.browser;
    if (this.launching) return this.launching;
    this.launching = (async () => {
      const puppeteer = await import('puppeteer-core');
      const executablePath = detectChromium(this.opts.executablePath);
      if (!executablePath) {
        throw new Error('chromium_not_found');
      }
      this.opts.log.info({ executablePath }, 'mockup renderer: launching chromium (software webgl)');
      const browser = await puppeteer.launch({
        executablePath,
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          // 服务器没有 GPU：显式启用 Chromium 自带的 SwiftShader 软件渲染
          '--disable-gpu',
          '--enable-unsafe-swiftshader',
          '--use-gl=angle',
          '--use-angle=swiftshader',
          '--disable-background-timer-throttling',
          '--disable-renderer-backgrounding',
          '--disable-backgrounding-occluded-windows',
          '--js-flags=--max-old-space-size=768'
        ]
      });
      browser.on('disconnected', () => {
        this.browser = null;
        this.pool = [];
        if (!this.disposed) this.opts.log.warn('mockup renderer: chromium disconnected, will relaunch on demand');
      });
      this.browser = browser;
      return browser;
    })();
    try {
      return await this.launching;
    } finally {
      this.launching = null;
    }
  }

  private async acquire(): Promise<PoolEntry> {
    const idle = this.pool.find((p) => !p.busy);
    if (idle) {
      idle.busy = true;
      return idle;
    }
    if (this.pool.length < this.opts.concurrency) {
      const browser = await this.ensureBrowser();
      const page = await browser.newPage();
      await page.setViewport({ width: 1200, height: 900 });
      page.on('pageerror', (error) => this.opts.log.warn({ err: error }, 'mockup renderer: page error'));
      const entry: PoolEntry = { page, busy: true, frameReady: false, renders: 0 };
      this.pool.push(entry);
      return entry;
    }
    // 槽位已满：排队。超过上限直接拒绝，避免请求堆积把服务器拖垮。
    if (this.waiters.length >= this.opts.queueLimit) throw new Error('renderer_overloaded');
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    return this.acquire();
  }

  private release(entry: PoolEntry) {
    entry.busy = false;
    const next = this.waiters.shift();
    if (next) next();
  }

  private async ensureFrame(entry: PoolEntry) {
    if (entry.frameReady) return;
    await entry.page.goto('about:blank');
    const origin = this.opts.localOrigin;
    await entry.page.setContent(
      `<!doctype html><html><body style="margin:0"><iframe id="rf" src="${origin}${RENDERER_FRAME_PATH}" style="width:1200px;height:900px;border:0"></iframe></body></html>`,
      { waitUntil: 'load', timeout: 60000 }
    );
    await entry.page.waitForFunction(
      () => {
        const f = document.getElementById('rf') as HTMLIFrameElement | null;
        return !!f && !!f.contentWindow && !!f.contentDocument;
      },
      { timeout: 30000 }
    );
    // 等引擎 JS 加载完成（外壳页会发 loaded；这里用轮询兜底）
    await entry.page.waitForTimeout(600);
    entry.frameReady = true;
  }

  /** 在页面上下文里完成一次 init → ready → render → rendered 往返 */
  private renderInPage(entry: PoolEntry, job: RenderJob): Promise<string> {
    const localOrigin = this.opts.localOrigin;
    return entry.page.evaluate(
      async (args: { sceneUrl: string; viewId: string; cdnPrefix: string; sides: RenderSide[]; surfaces: RenderSurface[]; outputSize: number; timeoutMs: number }) => {
        const frame = document.getElementById('rf') as HTMLIFrameElement;
        const win = frame.contentWindow as Window;
        const token = Math.floor(Math.random() * 1e9) + 1;

        const waitFor = (type: string, ms: number) =>
          new Promise<Record<string, unknown>>((resolve, reject) => {
            const timer = setTimeout(() => {
              window.removeEventListener('message', on);
              reject(new Error(type + '_timeout'));
            }, ms);
            function on(e: MessageEvent) {
              const d = e.data as { source?: string; type?: string; detail?: Record<string, unknown> } | null;
              if (!d || d.source !== 'hxpd-renderer' || d.type !== type) return;
              if (Number(d.detail?.token) !== token) return;
              window.removeEventListener('message', on);
              clearTimeout(timer);
              resolve(d.detail || {});
            }
            window.addEventListener('message', on);
          });

        const readyWait = waitFor('ready', args.timeoutMs);
        win.postMessage(
          {
            source: 'hxpd-host',
            type: 'init',
            token,
            sceneUrl: args.sceneUrl,
            viewId: args.viewId,
            sides: args.sides,
            cdnPrefix: args.cdnPrefix,
            cacheLimit: 2,
            renderSize: 500,
            sceneItemRenderSize: 1500
          },
          '*'
        );
        await readyWait;

        const renderedWait = waitFor('rendered', args.timeoutMs);
        win.postMessage(
          {
            source: 'hxpd-host',
            type: 'render',
            token,
            surfaces: args.surfaces,
            timeout: args.timeoutMs,
            outputSize: args.outputSize,
            outputType: 'image/webp',
            outputQuality: 0.86
          },
          '*'
        );
        const detail = await renderedWait;
        const snapshot = detail.snapshot as string | undefined;
        if (!snapshot || snapshot.length < 1500) throw new Error('blank_snapshot');
        return snapshot;
      },
      {
        sceneUrl: toLocal(job.sceneUrl, localOrigin),
        viewId: job.viewId,
        cdnPrefix: toLocal(job.cdnPrefix, localOrigin),
        sides: job.sides,
        surfaces: job.surfaces,
        outputSize: job.outputSize,
        timeoutMs: this.opts.renderTimeoutMs
      }
    );
  }

  async render(job: RenderJob): Promise<string> {
    const key = createHash('sha256')
      .update(
        JSON.stringify({
          s: job.sceneUrl,
          v: job.viewId,
          p: job.cdnPrefix,
          o: job.outputSize,
          d: job.sides.map((s) => s.id).join(','),
          u: job.surfaces.map((s) => s.sideId + ':' + createHash('sha1').update(s.surface).digest('hex'))
        })
      )
      .digest('hex');
    const hit = this.cache.get(key);
    if (hit) return hit;
    if (this.disposed) throw new Error('renderer_disposed');

    const entry = await this.acquire();
    this.inflight++;
    try {
      await this.ensureFrame(entry);
      const snapshot = await this.renderInPage(entry, job);
      entry.renders++;
      if (this.cache.size >= this.opts.cacheLimit) this.cache.clear();
      this.cache.set(key, snapshot);
      return snapshot;
    } catch (error) {
      // 失败时丢弃该页面，下次重建，避免坏状态粘住
      entry.frameReady = false;
      try {
        await entry.page.goto('about:blank');
      } catch {
        /* ignore */
      }
      throw error;
    } finally {
      this.inflight--;
      this.release(entry);
    }
  }

  async close() {
    this.disposed = true;
    const browser = this.browser;
    this.browser = null;
    this.pool = [];
    if (browser) await browser.close().catch(() => undefined);
  }
}
