import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { Design } from './schemas.js';

export type StoredDesign = { id: string; createdAt: string; updatedAt: string; design: Design };

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
        design jsonb NOT NULL
      )
    `);
  }

  async upsert(design: Design) {
    if (!this.pool) {
      const now = new Date().toISOString();
      const id = design.id ?? randomUUID();
      const existing = this.memory.get(id);
      const record: StoredDesign = { id, createdAt: existing?.createdAt ?? now, updatedAt: now, design };
      this.memory.set(id, record);
      return record;
    }
    const id = design.id ?? randomUUID();
    const result = await this.pool.query(
      `INSERT INTO ${this.tableName} (id, created_at, updated_at, design)
       VALUES ($1, now(), now(), $2::jsonb)
       ON CONFLICT (id) DO UPDATE SET design = EXCLUDED.design, updated_at = now()
       RETURNING id, created_at, updated_at, design`,
      [id, JSON.stringify(design)]
    );
    const row = result.rows[0];
    return {
      id: row.id,
      createdAt: (row.created_at as Date).toISOString(),
      updatedAt: (row.updated_at as Date).toISOString(),
      design: row.design as Design,
    };
  }

  async get(id: string) {
    if (!this.pool) return this.memory.get(id) ?? null;
    const result = await this.pool.query(
      `SELECT id, created_at, updated_at, design FROM ${this.tableName} WHERE id = $1`,
      [id]
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      createdAt: (row.created_at as Date).toISOString(),
      updatedAt: (row.updated_at as Date).toISOString(),
      design: row.design as Design,
    };
  }
}
