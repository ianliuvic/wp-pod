import { createHash, randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';

/** 设计器拍平后提交的一"片"（每个版片一张 PNG） */
export type IntakeSideInput = {
  sideId: string;
  name?: string | null;
  width?: number | null;
  height?: number | null;
  mime?: string | null;
  dataUrl: string;
};

export type IntakeInput = {
  designId?: string | null;
  productId: string;
  productName?: string | null;
  modeKind: string;
  templateName?: string | null;
  shopifyDomain?: string | null;
  source?: string | null;
  sides: IntakeSideInput[];
  design?: unknown;
  meta?: unknown;
};

export type IntakeSide = {
  sideId: string;
  name: string | null;
  width: number | null;
  height: number | null;
  mime: string;
  bytes: number;
  sha256: string;
  url: string;
};

export type IntakeOrder = {
  id: string;
  intakeId: string;
  orderId: string | null;
  orderName: string | null;
  size: string | null;
  quantity: number;
  variantId: string | null;
  lineItemId: string | null;
  source: string;
  raw: unknown;
  createdAt: string;
};

export type IntakeRecord = {
  id: string;
  designId: string | null;
  productId: string;
  productName: string | null;
  modeKind: string;
  templateName: string | null;
  shopifyDomain: string | null;
  source: string | null;
  sides: IntakeSide[];
  design: unknown;
  meta: unknown;
  status: string;
  sds: unknown;
  sdsAt: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

export type IntakeOrderInput = {
  size?: string | null;
  quantity?: number | null;
  orderId?: string | null;
  orderName?: string | null;
  variantId?: string | null;
  lineItemId?: string | null;
  source?: string | null;
  raw?: unknown;
};

export type IntakeSdsPatch = {
  status: string;
  sds?: unknown;
  error?: string | null;
};

export type IntakeStatsDay = {
  date: string;
  created: number;
  pending: number;
  cartAdded: number;
  failed: number;
  ordered: number;
  orderUnits: number;
};

type MemoryRow = { record: IntakeRecord; sides: Map<string, Buffer>; orders: IntakeOrder[] };

const INTAKE_STATUSES = ['pending', 'cart_added', 'failed', 'skipped'] as const;

function decodeDataUrl(dataUrl: string): { mime: string; bytes: Buffer } {
  const match = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(dataUrl);
  if (!match) throw new Error('invalid_surface_data_url');
  return { mime: match[1].toLowerCase(), bytes: Buffer.from(match[2], 'base64') };
}

function dayKey(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString().slice(0, 10);
}

export class IntakeStore {
  private readonly pool: Pool | null;
  private readonly baseUrl: string;
  private readonly table: string;
  private readonly sidesTable: string;
  private readonly ordersTable: string;
  private readonly memory = new Map<string, MemoryRow>();

  constructor(databaseUrl?: string, publicBaseUrl = '', tableName = 'pod_intakes') {
    if (!/^[a-z][a-z0-9_]*$/.test(tableName)) throw new Error('Invalid intake table name');
    this.table = tableName;
    this.sidesTable = `${tableName}_sides`;
    this.ordersTable = `${tableName}_orders`;
    this.baseUrl = publicBaseUrl.replace(/\/+$/, '');
    this.pool = databaseUrl ? new Pool({ connectionString: databaseUrl, max: 5 }) : null;
  }

  /** 是否落库（false = 进程内内存存储，仅用于本地/测试） */
  get persistent(): boolean {
    return !!this.pool;
  }

  async init() {
    if (!this.pool) return;
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.table} (
        id uuid PRIMARY KEY,
        design_id text,
        product_id text NOT NULL,
        product_name text,
        mode_kind text NOT NULL,
        template_name text,
        shopify_domain text,
        source text,
        sides jsonb NOT NULL DEFAULT '[]'::jsonb,
        design jsonb,
        meta jsonb,
        status text NOT NULL DEFAULT 'pending',
        sds jsonb,
        sds_at timestamptz,
        error text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS ${this.table}_created_idx ON ${this.table} (created_at DESC)`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS ${this.table}_status_idx ON ${this.table} (status)`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS ${this.table}_design_idx ON ${this.table} (design_id)`);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.sidesTable} (
        intake_id uuid NOT NULL REFERENCES ${this.table}(id) ON DELETE CASCADE,
        side_id text NOT NULL,
        mime text NOT NULL,
        sha256 text NOT NULL,
        bytes bytea NOT NULL,
        PRIMARY KEY (intake_id, side_id)
      )
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.ordersTable} (
        id uuid PRIMARY KEY,
        intake_id uuid NOT NULL REFERENCES ${this.table}(id) ON DELETE CASCADE,
        order_id text,
        order_name text,
        size text,
        quantity integer NOT NULL DEFAULT 0,
        variant_id text,
        line_item_id text,
        source text NOT NULL DEFAULT 'simulate',
        raw jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS ${this.ordersTable}_intake_idx ON ${this.ordersTable} (intake_id)`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS ${this.ordersTable}_order_idx ON ${this.ordersTable} (order_id)`);
  }

  private sideUrl(intakeId: string, sideId: string): string {
    return `${this.baseUrl}/v1/intakes/${intakeId}/sides/${encodeURIComponent(sideId)}.png`;
  }

  async create(input: IntakeInput): Promise<IntakeRecord> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const sides: IntakeSide[] = [];
    const blobs = new Map<string, Buffer>();
    for (const side of input.sides) {
      const decoded = decodeDataUrl(side.dataUrl);
      const sha256 = createHash('sha256').update(decoded.bytes).digest('hex');
      sides.push({
        sideId: side.sideId,
        name: side.name ?? null,
        width: side.width ?? null,
        height: side.height ?? null,
        mime: decoded.mime,
        bytes: decoded.bytes.length,
        sha256,
        url: this.sideUrl(id, side.sideId)
      });
      blobs.set(side.sideId, decoded.bytes);
    }
    const record: IntakeRecord = {
      id,
      designId: input.designId ?? null,
      productId: input.productId,
      productName: input.productName ?? null,
      modeKind: input.modeKind,
      templateName: input.templateName ?? null,
      shopifyDomain: input.shopifyDomain ?? null,
      source: input.source ?? null,
      sides,
      design: input.design ?? null,
      meta: input.meta ?? null,
      status: 'pending',
      sds: null,
      sdsAt: null,
      error: null,
      createdAt: now,
      updatedAt: now
    };
    if (!this.pool) {
      const sideMap = new Map<string, Buffer>();
      blobs.forEach((buffer, sideId) => sideMap.set(sideId, buffer));
      this.memory.set(id, { record, sides: sideMap, orders: [] });
      return record;
    }
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO ${this.table} (id, design_id, product_id, product_name, mode_kind, template_name, shopify_domain, source, sides, design, meta, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12)`,
        [
          id,
          record.designId,
          record.productId,
          record.productName,
          record.modeKind,
          record.templateName,
          record.shopifyDomain,
          record.source,
          JSON.stringify(sides),
          input.design === undefined ? null : JSON.stringify(input.design),
          input.meta === undefined ? null : JSON.stringify(input.meta),
          record.status
        ]
      );
      for (const [sideId, buffer] of blobs) {
        const meta = sides.find((item) => item.sideId === sideId);
        await client.query(
          `INSERT INTO ${this.sidesTable} (intake_id, side_id, mime, sha256, bytes) VALUES ($1,$2,$3,$4,$5)`,
          [id, sideId, meta?.mime ?? 'image/png', meta?.sha256 ?? '', buffer]
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    return record;
  }

  private rowToRecord(row: Record<string, unknown>, orders: IntakeOrder[] = []): IntakeRecord {
    const record: IntakeRecord = {
      id: String(row.id),
      designId: (row.design_id as string | null) ?? null,
      productId: String(row.product_id),
      productName: (row.product_name as string | null) ?? null,
      modeKind: String(row.mode_kind),
      templateName: (row.template_name as string | null) ?? null,
      shopifyDomain: (row.shopify_domain as string | null) ?? null,
      source: (row.source as string | null) ?? null,
      sides: (row.sides as IntakeSide[]) ?? [],
      design: row.design ?? null,
      meta: row.meta ?? null,
      status: String(row.status),
      sds: row.sds ?? null,
      sdsAt: row.sds_at ? (row.sds_at as Date).toISOString() : null,
      error: (row.error as string | null) ?? null,
      createdAt: (row.created_at as Date).toISOString(),
      updatedAt: (row.updated_at as Date).toISOString()
    };
    if (orders.length) return Object.assign(record, { orders });
    return record;
  }

  private rowToOrder(row: Record<string, unknown>): IntakeOrder {
    return {
      id: String(row.id),
      intakeId: String(row.intake_id),
      orderId: (row.order_id as string | null) ?? null,
      orderName: (row.order_name as string | null) ?? null,
      size: (row.size as string | null) ?? null,
      quantity: Number(row.quantity) || 0,
      variantId: (row.variant_id as string | null) ?? null,
      lineItemId: (row.line_item_id as string | null) ?? null,
      source: String(row.source ?? 'simulate'),
      raw: row.raw ?? null,
      createdAt: (row.created_at as Date).toISOString()
    };
  }

  private memoryOrders(id: string): IntakeOrder[] {
    return this.memory.get(id)?.orders ?? [];
  }

  async get(id: string): Promise<(IntakeRecord & { orders: IntakeOrder[] }) | null> {
    if (!this.pool) {
      const row = this.memory.get(id);
      if (!row) return null;
      return Object.assign({}, row.record, { orders: row.orders.slice() });
    }
    const result = await this.pool.query(`SELECT * FROM ${this.table} WHERE id = $1`, [id]);
    const row = result.rows[0];
    if (!row) return null;
    const orders = await this.pool.query(`SELECT * FROM ${this.ordersTable} WHERE intake_id = $1 ORDER BY created_at ASC`, [id]);
    return Object.assign(this.rowToRecord(row), { orders: orders.rows.map((item) => this.rowToOrder(item)) });
  }

  async getByDesignId(designId: string): Promise<IntakeRecord | null> {
    if (!this.pool) {
      for (const row of this.memory.values()) if (row.record.designId === designId) return row.record;
      return null;
    }
    const result = await this.pool.query(
      `SELECT * FROM ${this.table} WHERE design_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [designId]
    );
    const row = result.rows[0];
    return row ? this.rowToRecord(row) : null;
  }

  async list(options: { status?: string | null; date?: string | null; productId?: string | null; limit?: number; offset?: number } = {}): Promise<{ total: number; items: IntakeRecord[] }> {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 500);
    const offset = Math.max(options.offset ?? 0, 0);
    if (!this.pool) {
      let items = [...this.memory.values()].map((row) => row.record);
      if (options.status) items = items.filter((item) => item.status === options.status);
      if (options.productId) items = items.filter((item) => item.productId === options.productId);
      if (options.date) items = items.filter((item) => dayKey(item.createdAt) === options.date);
      items.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      return { total: items.length, items: items.slice(offset, offset + limit) };
    }
    const result = await this.pool.query(
      `SELECT * FROM ${this.table}
       WHERE ($1::text IS NULL OR status = $1)
         AND ($2::text IS NULL OR product_id = $2)
         AND ($3::date IS NULL OR (created_at >= $3::date AND created_at < ($3::date + interval '1 day')))
       ORDER BY created_at DESC LIMIT $4 OFFSET $5`,
      [options.status ?? null, options.productId ?? null, options.date ?? null, limit, offset]
    );
    const count = await this.pool.query(
      `SELECT count(*)::int AS total FROM ${this.table}
       WHERE ($1::text IS NULL OR status = $1)
         AND ($2::text IS NULL OR product_id = $2)
         AND ($3::date IS NULL OR (created_at >= $3::date AND created_at < ($3::date + interval '1 day')))`,
      [options.status ?? null, options.productId ?? null, options.date ?? null]
    );
    return { total: Number(count.rows[0]?.total ?? 0), items: result.rows.map((row) => this.rowToRecord(row)) };
  }

  /** 每日统计：新增 / 待与 SDS 交互 / 已加购 / 失败 / 已下单，默认最近 14 天 */
  async stats(options: { days?: number; date?: string | null } = {}): Promise<{ today: IntakeStatsDay; days: IntakeStatsDay[] }> {
    const days = Math.min(Math.max(options.days ?? 14, 1), 90);
    const todayKey = options.date ?? dayKey(new Date());
    if (!this.pool) {
      const map = new Map<string, IntakeStatsDay>();
      const key = (value: string) => value.slice(0, 10);
      for (const row of this.memory.values()) {
        const date = key(row.record.createdAt);
        const entry = map.get(date) ?? { date, created: 0, pending: 0, cartAdded: 0, failed: 0, ordered: 0, orderUnits: 0 };
        entry.created += 1;
        if (row.record.status === 'pending') entry.pending += 1;
        if (row.record.status === 'cart_added') entry.cartAdded += 1;
        if (row.record.status === 'failed') entry.failed += 1;
        if (row.orders.length) {
          entry.ordered += 1;
          entry.orderUnits += row.orders.reduce((sum, order) => sum + (order.quantity || 0), 0);
        }
        map.set(date, entry);
      }
      const trend = [...map.values()].sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, days);
      const today = trend.find((item) => item.date === todayKey) ?? { date: todayKey, created: 0, pending: 0, cartAdded: 0, failed: 0, ordered: 0, orderUnits: 0 };
      return { today, days: trend };
    }
    const trend = await this.pool.query(
      `WITH span AS (
         SELECT generate_series((now()::date - ($1::int - 1)), now()::date, interval '1 day')::date AS date
       )
       SELECT to_char(span.date, 'YYYY-MM-DD') AS date,
              COALESCE(count(i.id), 0)::int AS created,
              COALESCE(count(i.id) FILTER (WHERE i.status = 'pending'), 0)::int AS pending,
              COALESCE(count(i.id) FILTER (WHERE i.status = 'cart_added'), 0)::int AS cart_added,
              COALESCE(count(i.id) FILTER (WHERE i.status = 'failed'), 0)::int AS failed,
              COALESCE(count(DISTINCT o.intake_id), 0)::int AS ordered,
              COALESCE(sum(o.quantity), 0)::int AS order_units
         FROM span
         LEFT JOIN ${this.table} i ON i.created_at >= span.date AND i.created_at < span.date + interval '1 day'
         LEFT JOIN ${this.ordersTable} o ON o.intake_id = i.id
        GROUP BY span.date
        ORDER BY span.date DESC`,
      [days]
    );
    const rows: IntakeStatsDay[] = trend.rows.map((row) => ({
      date: String(row.date),
      created: Number(row.created) || 0,
      pending: Number(row.pending) || 0,
      cartAdded: Number(row.cart_added) || 0,
      failed: Number(row.failed) || 0,
      ordered: Number(row.ordered) || 0,
      orderUnits: Number(row.order_units) || 0
    }));
    const today = rows.find((row) => row.date === todayKey) ?? { date: todayKey, created: 0, pending: 0, cartAdded: 0, failed: 0, ordered: 0, orderUnits: 0 };
    return { today, days: rows };
  }

  async sideBytes(id: string, sideId: string): Promise<{ mime: string; bytes: Buffer } | null> {
    if (!this.pool) {
      const row = this.memory.get(id);
      const bytes = row?.sides.get(sideId);
      if (!row || !bytes) return null;
      const meta = row.record.sides.find((item) => item.sideId === sideId);
      return { mime: meta?.mime ?? 'image/png', bytes };
    }
    const result = await this.pool.query(
      `SELECT mime, bytes FROM ${this.sidesTable} WHERE intake_id = $1 AND side_id = $2`,
      [id, sideId]
    );
    const row = result.rows[0];
    return row ? { mime: String(row.mime), bytes: row.bytes as Buffer } : null;
  }

  /** 订单绑定：真实购买（webhook）或测试模拟（simulate / cart） */
  async addOrder(id: string, input: IntakeOrderInput): Promise<IntakeOrder | null> {
    const exists = await this.get(id);
    if (!exists) return null;
    const order: IntakeOrder = {
      id: randomUUID(),
      intakeId: id,
      orderId: input.orderId ?? null,
      orderName: input.orderName ?? null,
      size: input.size ?? null,
      quantity: Math.max(0, Math.min(999, Math.trunc(Number(input.quantity) || 0))),
      variantId: input.variantId ?? null,
      lineItemId: input.lineItemId ?? null,
      source: input.source ?? 'simulate',
      raw: input.raw ?? null,
      createdAt: new Date().toISOString()
    };
    if (!this.pool) {
      const row = this.memory.get(id);
      row?.orders.push(order);
      return order;
    }
    await this.pool.query(
      `INSERT INTO ${this.ordersTable} (id, intake_id, order_id, order_name, size, quantity, variant_id, line_item_id, source, raw)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
      [
        order.id,
        order.intakeId,
        order.orderId,
        order.orderName,
        order.size,
        order.quantity,
        order.variantId,
        order.lineItemId,
        order.source,
        input.raw === undefined ? null : JSON.stringify(input.raw)
      ]
    );
    return order;
  }

  /** worker 回写：把与 SDS 交互的结果写回 */
  async setSds(id: string, patch: IntakeSdsPatch): Promise<IntakeRecord | null> {
    const status = (INTAKE_STATUSES as readonly string[]).includes(patch.status) ? patch.status : patch.status;
    if (!this.pool) {
      const row = this.memory.get(id);
      if (!row) return null;
      row.record.status = status;
      row.record.sds = patch.sds ?? row.record.sds;
      row.record.error = patch.error ?? null;
      row.record.sdsAt = new Date().toISOString();
      row.record.updatedAt = row.record.sdsAt;
      return row.record;
    }
    const result = await this.pool.query(
      `UPDATE ${this.table}
          SET status = $2,
              sds = COALESCE($3::jsonb, sds),
              error = $4,
              sds_at = CASE WHEN $2 = 'pending' THEN sds_at ELSE now() END,
              updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [id, status, patch.sds === undefined ? null : JSON.stringify(patch.sds), patch.error ?? null]
    );
    const row = result.rows[0];
    return row ? this.rowToRecord(row) : null;
  }
}
