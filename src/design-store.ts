import { randomUUID } from 'node:crypto';
import type { Design } from './schemas.js';

export type StoredDesign = { id: string; createdAt: string; updatedAt: string; design: Design };
export class DesignStore {
  private readonly records = new Map<string, StoredDesign>();
  upsert(design: Design) {
    const now = new Date().toISOString();
    const id = design.id ?? randomUUID();
    const existing = this.records.get(id);
    const record: StoredDesign = { id, createdAt: existing?.createdAt ?? now, updatedAt: now, design };
    this.records.set(id, record); return record;
  }
  get(id: string) { return this.records.get(id) ?? null; }
}
