import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { Design } from './schemas.js';

export type StoredDesign = { id: string; createdAt: string; updatedAt: string; shopDomain: string | null; design: Design };
export type StoredDesignPage = { designs: StoredDesign[]; total: number };

export class DesignStore {
  private readonly pool: Pool | null;
  private readonly memory = new Map<string, StoredDesign>();
  private readonly tableName: string;

  constructor(databaseUrl?: string, tableName = 'designs') {
    if (!/^[a-z][a-z0-9_]*$/.test(tableName)) throw new Error('Invalid design table name');
    this.tableName = tableName;
    this.pool = databaseUrl ? new Pool({ connectionString: databaseUrl, max: 5 }) : null;
  }

  async init() {
    if (!this.pool) return;
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.tableName} (
        id uuid PRIMARY KEY,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        design jsonb NOT NULL,
        shop_domain text
      )
    `);
    // additive migration for databases created before tenant isolation
    await this.pool.query(`ALTER TABLE ${this.tableName} ADD COLUMN IF NOT EXISTS shop_domain text`);
  }

  async upsert(design: Design, shopDomain: string | null = null) {
    if (!this.pool) {
      const now = new Date().toISOString();
      const id = design.id ?? randomUUID();
      const existing = this.memory.get(id);
      const record: StoredDesign = {
        id,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        shopDomain: shopDomain ?? existing?.shopDomain ?? null,
        design,
      };
      this.memory.set(id, record);
      return record;
    }
    const id = design.id ?? randomUUID();
    const result = await this.pool.query(
      `INSERT INTO ${this.tableName} (id, created_at, updated_at, shop_domain, design)
       VALUES ($1, now(), now(), $2, $3::jsonb)
       ON CONFLICT (id) DO UPDATE SET design = EXCLUDED.design, updated_at = now(),
         shop_domain = COALESCE(EXCLUDED.shop_domain, ${this.tableName}.shop_domain)
       RETURNING id, created_at, updated_at, shop_domain, design`,
      [id, shopDomain, JSON.stringify(design)]
    );
    const row = result.rows[0];
    return {
      id: row.id,
      createdAt: (row.created_at as Date).toISOString(),
      updatedAt: (row.updated_at as Date).toISOString(),
      shopDomain: (row.shop_domain as string | null) ?? null,
      design: row.design as Design,
    };
  }

  async get(id: string) {
    if (!this.pool) return this.memory.get(id) ?? null;
    const result = await this.pool.query(
      `SELECT id, created_at, updated_at, shop_domain, design FROM ${this.tableName} WHERE id = $1`,
      [id]
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      createdAt: (row.created_at as Date).toISOString(),
      updatedAt: (row.updated_at as Date).toISOString(),
      shopDomain: (row.shop_domain as string | null) ?? null,
      design: row.design as Design,
    };
  }

  async listCreatedBetween(
    since: Date,
    until: Date,
    limit: number,
    offset: number,
    shopDomain: string | null = null
  ): Promise<StoredDesignPage> {
    if (!this.pool) {
      const matching = [...this.memory.values()]
        .filter((record) => record.createdAt >= since.toISOString() && record.createdAt < until.toISOString())
        .filter((record) => !shopDomain || record.shopDomain === shopDomain)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
      return { designs: matching.slice(offset, offset + limit), total: matching.length };
    }
    const result = await this.pool.query(
      `SELECT id, created_at, updated_at, shop_domain, design, count(*) OVER()::int AS total
       FROM ${this.tableName}
       WHERE created_at >= $1 AND created_at < $2
         AND ($5::text IS NULL OR shop_domain = $5)
       ORDER BY created_at ASC, id ASC
       LIMIT $3 OFFSET $4`,
      [since.toISOString(), until.toISOString(), limit, offset, shopDomain]
    );
    return {
      designs: result.rows.map((row) => ({
        id: row.id,
        createdAt: (row.created_at as Date).toISOString(),
        updatedAt: (row.updated_at as Date).toISOString(),
        shopDomain: (row.shop_domain as string | null) ?? null,
        design: row.design as Design,
      })),
      total: result.rows.length > 0 ? Number(result.rows[0].total) : 0,
    };
  }
}
