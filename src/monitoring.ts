import fs from 'node:fs/promises';
import os from 'node:os';

type RequestSample = {
  at: number;
  durationMs: number;
  route: string;
  statusCode: number;
};

type CpuSample = {
  at: number;
  usageMicros: number;
};

const WINDOW_MS = 5 * 60 * 1000;
const MAX_SAMPLES = 20_000;

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function normalizeUnknownRoute(url: string): string {
  return url.split('?')[0]
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ':id')
    .replace(/\/\d+(?=\/|$)/g, '/:id');
}

export class MonitoringCollector {
  private readonly startedAt = Date.now();
  private readonly requests: RequestSample[] = [];
  private cpuSample: CpuSample = this.readCpuSample();

  record(routePattern: string | undefined, url: string, statusCode: number, durationMs: number): void {
    const route = routePattern || normalizeUnknownRoute(url);
    if (route === '/internal/metrics') return;
    const now = Date.now();
    this.requests.push({ at: now, durationMs, route, statusCode });
    this.prune(now);
  }

  async snapshot(diskPath: string) {
    const now = Date.now();
    this.prune(now);
    const cpuNow = this.readCpuSample();
    const elapsedMicros = Math.max(1, (cpuNow.at - this.cpuSample.at) * 1_000);
    const usedMicros = Math.max(0, cpuNow.usageMicros - this.cpuSample.usageMicros);
    const cpuPercent = Math.min(100, (usedMicros / elapsedMicros) * 100);
    this.cpuSample = cpuNow;

    const memory = process.memoryUsage();
    const memoryLimitBytes = await this.readMemoryLimit();
    const disk = await this.readDisk(diskPath);
    const routes = new Map<string, RequestSample[]>();
    for (const sample of this.requests) {
      const list = routes.get(sample.route) ?? [];
      list.push(sample);
      routes.set(sample.route, list);
    }
    const summarize = (samples: RequestSample[]) => {
      const durations = samples.map((sample) => sample.durationMs);
      const errors = samples.filter((sample) => sample.statusCode >= 500).length;
      return {
        requests: samples.length,
        errors,
        errorRatePercent: samples.length ? round((errors / samples.length) * 100) : 0,
        averageDurationMs: samples.length ? round(durations.reduce((sum, value) => sum + value, 0) / samples.length) : 0,
        p95DurationMs: round(percentile(durations, 0.95)),
        maxDurationMs: round(Math.max(0, ...durations))
      };
    };

    return {
      schema: 'pod-backend-metrics-v1',
      service: 'wp-pod-api',
      environment: process.env.NODE_ENV ?? 'development',
      timestamp: new Date(now).toISOString(),
      uptimeSeconds: Math.floor((now - this.startedAt) / 1_000),
      http: {
        windowSeconds: WINDOW_MS / 1_000,
        ...summarize(this.requests),
        routes: [...routes.entries()].map(([route, samples]) => ({ route, ...summarize(samples) }))
      },
      cpu: {
        usagePercent: round(cpuPercent),
        availableProcessors: os.availableParallelism()
      },
      memory: {
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        heapTotalBytes: memory.heapTotal,
        limitBytes: memoryLimitBytes,
        usagePercent: memoryLimitBytes ? round((memory.rss / memoryLimitBytes) * 100) : null
      },
      disk
    };
  }

  private prune(now: number): void {
    const cutoff = now - WINDOW_MS;
    let remove = 0;
    while (remove < this.requests.length && this.requests[remove].at < cutoff) remove += 1;
    if (remove > 0) this.requests.splice(0, remove);
    if (this.requests.length > MAX_SAMPLES) this.requests.splice(0, this.requests.length - MAX_SAMPLES);
  }

  private readCpuSample(): CpuSample {
    const usage = process.cpuUsage();
    return { at: Date.now(), usageMicros: usage.user + usage.system };
  }

  private async readMemoryLimit(): Promise<number | null> {
    for (const file of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
      try {
        const raw = (await fs.readFile(file, 'utf8')).trim();
        if (raw !== 'max') {
          const value = Number(raw);
          if (Number.isFinite(value) && value > 0 && value < 2 ** 60) return value;
        }
      } catch { /* Try the next cgroup layout. */ }
    }
    const total = os.totalmem();
    return total > 0 ? total : null;
  }

  private async readDisk(diskPath: string) {
    try {
      const stats = await fs.statfs(diskPath);
      const totalBytes = Number(stats.blocks) * Number(stats.bsize);
      const availableBytes = Number(stats.bavail) * Number(stats.bsize);
      const usedBytes = Math.max(0, totalBytes - availableBytes);
      return {
        path: diskPath,
        totalBytes,
        usedBytes,
        availableBytes,
        usagePercent: totalBytes ? round((usedBytes / totalBytes) * 100) : null
      };
    } catch {
      return { path: diskPath, totalBytes: null, usedBytes: null, availableBytes: null, usagePercent: null };
    }
  }
}
