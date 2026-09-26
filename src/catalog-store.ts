import { Pool } from 'pg';
import type { CatalogSnapshotEntry } from './asset-store.js';

export type CatalogEntry = CatalogSnapshotEntry & { inArchive: boolean; refreshedAt: string | null };

export type CatalogListOptions = {
  q?: string | null;
  category?: string | null;
  status?: string | null;
  includeRemoved?: boolean;
  limit?: number;
  offset?: number;
};

export type CatalogStats = {
  total: number;
  inArchive: number;
  removed: number;
  categories: Array<{ id: string; label: string; count: number }>;
  statuses: Record<string, number>;
};

/**
 * Queryable index of the archived POD catalogue. The file archive stays the
 * source of truth; this store is rebuilt from it (see AssetStore.catalogSnapshot).
 */
export class CatalogStore {
  private readonly pool: Pool | null;
  private readonly memory = new Map<string, CatalogEntry>();
  private readonly tableName: string;
  private readonly categoriesTable: string;

  constructor(databaseUrl?: string, tableName = 'pod_products') {
    if (!/^[a-z][a-z0-9_]*$/.test(tableName)) throw new Error('Invalid catalog table name');
    this.tableName = tableName;
    this.categoriesTable = `${tableName}_categories`;
    this.pool = databaseUrl ? new Pool({ connectionString: databaseUrl, max: 5 }) : null;
  }

  async init() {
    if (!this.pool) return;
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.tableName} (
        id text PRIMARY KEY,
        name text NOT NULL,
        design_product_id text,
        modes jsonb NOT NULL DEFAULT '[]'::jsonb,
        categories jsonb NOT NULL DEFAULT '[]'::jsonb,
        thumbnail_url text,
        print_areas jsonb NOT NULL DEFAULT '[]'::jsonb,
        status jsonb NOT NULL DEFAULT '{}'::jsonb,
        validation jsonb NOT NULL DEFAULT '{}'::jsonb,
        source jsonb NOT NULL DEFAULT '{}'::jsonb,
        record_updated_at timestamptz,
        in_archive boolean NOT NULL DEFAULT true,
        refreshed_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.pool.query(`ALTER TABLE ${this.tableName} ADD COLUMN IF NOT EXISTS in_archive boolean NOT NULL DEFAULT true`);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.categoriesTable} (
        product_id text NOT NULL REFERENCES ${this.tableName}(id) ON DELETE CASCADE,
        category_id text NOT NULL,
        label text NOT NULL,
        PRIMARY KEY (product_id, category_id)
      )
    `);
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS ${this.categoriesTable}_category_idx ON ${this.categoriesTable} (category_id)`,
    );
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS ${this.tableName}_name_idx ON ${this.tableName} (name)`,
    );
  }

  /** Rebuilds the index from an archive snapshot; products not present are kept and flagged. */
  async replaceAll(entries: CatalogSnapshotEntry[]): Promise<{ total: number; added: number; updated: number; removed: number }> {
    if (!this.pool) {
      const previous = new Set(this.memory.keys());
      this.memory.clear();
      for (const entry of entries) {
        this.memory.set(entry.id, { ...entry, inArchive: true, refreshedAt: new Date().toISOString() });
      }
      return {
        total: entries.length,
        added: [...this.memory.keys()].filter((id) => !previous.has(id)).length,
        updated: entries.filter((entry) => previous.has(entry.id)).length,
        removed: [...previous].filter((id) => !this.memory.has(id)).length,
      };
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE ${this.tableName} SET in_archive = false`);
      let added = 0;
      let updated = 0;
      for (const entry of entries) {
        const result = await client.query(
          `INSERT INTO ${this.tableName}
             (id, name, design_product_id, modes, categories, thumbnail_url, print_areas, status, validation, source, record_updated_at, in_archive, refreshed_at)
           VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,$11,true,now())
           ON CONFLICT (id) DO UPDATE SET
             name = EXCLUDED.name,
             design_product_id = EXCLUDED.design_product_id,
             modes = EXCLUDED.modes,
             categories = EXCLUDED.categories,
             thumbnail_url = EXCLUDED.thumbnail_url,
             print_areas = EXCLUDED.print_areas,
             status = EXCLUDED.status,
             validation = EXCLUDED.validation,
             source = EXCLUDED.source,
             record_updated_at = EXCLUDED.record_updated_at,
             in_archive = true,
             refreshed_at = now()
           RETURNING (xmax = 0) AS inserted`,
          [
            entry.id,
            entry.name,
            entry.designProductId,
            JSON.stringify(entry.modes ?? []),
            JSON.stringify(entry.categories ?? []),
            entry.thumbnailUrl ?? null,
            JSON.stringify(entry.printAreas ?? []),
            JSON.stringify(entry.status ?? {}),
            JSON.stringify(entry.validation ?? {}),
            JSON.stringify(entry.source ?? {}),
            entry.recordUpdatedAt ?? null,
          ],
        );
        if (result.rows[0]?.inserted) added += 1;
        else updated += 1;
        await client.query(`DELETE FROM ${this.categoriesTable} WHERE product_id = $1`, [entry.id]);
        for (const category of entry.categories ?? []) {
          if (category?.id == null || !category.label) continue;
          await client.query(
            `INSERT INTO ${this.categoriesTable} (product_id, category_id, label) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
            [entry.id, String(category.id), String(category.label)],
          );
        }
      }
      const removed = await client.query(`SELECT count(*)::int AS count FROM ${this.tableName} WHERE in_archive = false`);
      await client.query('COMMIT');
      return { total: entries.length, added, updated, removed: Number(removed.rows[0]?.count ?? 0) };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async list(options: CatalogListOptions = {}): Promise<{ total: number; items: CatalogEntry[] }> {
    const limit = Math.min(Math.max(Math.round(options.limit ?? 50), 1), 500);
    const offset = Math.max(Math.round(options.offset ?? 0), 0);
    if (!this.pool) {
      let items = [...this.memory.values()];
      if (!options.includeRemoved) items = items.filter((item) => item.inArchive);
      if (options.q) {
        const q = options.q.toLowerCase();
        items = items.filter((item) => item.id.includes(q) || item.name.toLowerCase().includes(q));
      }
      if (options.category) items = items.filter((item) => item.categories.some((category) => String(category.id) === String(options.category)));
      if (options.status) items = items.filter((item) => item.status?.pod === options.status || item.status?.detail === options.status);
      items.sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
      return { total: items.length, items: items.slice(offset, offset + limit) };
    }

    const values: unknown[] = [];
    const where: string[] = [];
    const push = (value: unknown): string => {
      values.push(value);
      return `$${values.length}`;
    };
    if (!options.includeRemoved) where.push('p.in_archive = true');
    if (options.q) {
      const pattern = push(`%${options.q}%`);
      where.push(`(p.id LIKE ${pattern} OR p.name ILIKE ${pattern})`);
    }
    if (options.category) {
      const category = push(String(options.category));
      where.push(`EXISTS (SELECT 1 FROM ${this.categoriesTable} c WHERE c.product_id = p.id AND c.category_id = ${category})`);
    }
    if (options.status) {
      const status = push(options.status);
      where.push(`(p.status->>'pod' = ${status} OR p.status->>'detail' = ${status})`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const limitParam = push(limit);
    const offsetParam = push(offset);
    const result = await this.pool.query(
      `SELECT p.*, count(*) OVER()::int AS total FROM ${this.tableName} p ${whereSql}
       ORDER BY p.name ASC, p.id ASC LIMIT ${limitParam} OFFSET ${offsetParam}`,
      values,
    );
    return {
      total: result.rows.length ? Number(result.rows[0].total) : 0,
      items: result.rows.map((row) => this.rowToEntry(row)),
    };
  }

  async get(id: string): Promise<CatalogEntry | null> {
    if (!this.pool) return this.memory.get(id) ?? null;
    const result = await this.pool.query(`SELECT * FROM ${this.tableName} WHERE id = $1`, [id]);
    return result.rows[0] ? this.rowToEntry(result.rows[0]) : null;
  }

  async stats(): Promise<CatalogStats> {
    if (!this.pool) {
      const categories = new Map<string, { id: string; label: string; count: number }>();
      const statuses: Record<string, number> = {};
      let inArchive = 0;
      let removed = 0;
      for (const item of this.memory.values()) {
        if (item.inArchive) inArchive += 1;
        else removed += 1;
        for (const category of item.categories) {
          const key = `${category.id ?? ''}|${category.label}`;
          const entry = categories.get(key) ?? { id: String(category.id ?? ''), label: category.label, count: 0 };
          entry.count += 1;
          categories.set(key, entry);
        }
        const pod = item.status?.pod ?? 'unknown';
        statuses[pod] = (statuses[pod] ?? 0) + 1;
      }
      return {
        total: this.memory.size,
        inArchive,
        removed,
        categories: [...categories.values()].sort((left, right) => right.count - left.count),
        statuses,
      };
    }
    const totals = await this.pool.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE in_archive)::int AS in_archive,
              count(*) FILTER (WHERE NOT in_archive)::int AS removed
       FROM ${this.tableName}`,
    );
    const categories = await this.pool.query(
      `SELECT category_id, label, count(*)::int AS count FROM ${this.categoriesTable}
       GROUP BY category_id, label ORDER BY count DESC, label ASC`,
    );
    const statuses = await this.pool.query(
      `SELECT coalesce(status->>'pod', 'unknown') AS pod, count(*)::int AS count FROM ${this.tableName} GROUP BY 1 ORDER BY count DESC`,
    );
    return {
      total: Number(totals.rows[0]?.total ?? 0),
      inArchive: Number(totals.rows[0]?.in_archive ?? 0),
      removed: Number(totals.rows[0]?.removed ?? 0),
      categories: categories.rows.map((row) => ({ id: String(row.category_id), label: String(row.label), count: Number(row.count) })),
      statuses: Object.fromEntries(statuses.rows.map((row) => [String(row.pod), Number(row.count)])),
    };
  }

  private rowToEntry(row: Record<string, any>): CatalogEntry {
    return {
      id: String(row.id),
      name: String(row.name),
      designProductId: (row.design_product_id as string | null) ?? null,
      modes: (row.modes as string[]) ?? [],
      categories: (row.categories as Array<{ id: string | null; label: string }>) ?? [],
      thumbnailUrl: (row.thumbnail_url as string | null) ?? null,
      printAreas: (row.print_areas as CatalogEntry['printAreas']) ?? [],
      status: (row.status as CatalogEntry['status']) ?? {},
      validation: (row.validation as Record<string, unknown>) ?? {},
      source: (row.source as CatalogEntry['source']) ?? { detail: null, design: null, search: null, capturedAt: null },
      recordUpdatedAt: row.record_updated_at ? (row.record_updated_at as Date).toISOString() : null,
      inArchive: row.in_archive !== false,
      refreshedAt: row.refreshed_at ? (row.refreshed_at as Date).toISOString() : null,
    };
  }
}
