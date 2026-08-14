import { randomUUID } from 'node:crypto';
import type { Design } from './schemas.js';

export type StoredDesign = { id: string; createdAt: string; updatedAt: string; design: Design };
export class DesignStore {
  private readonly records = new Map<string, StoredDesign>();
  create(design: Design) {
    const now = new Date().toISOString();
    const record = { id: randomUUID(), createdAt: now, updatedAt: now, design };
    this.records.set(record.id, record); return record;
  }
  get(id: string) { return this.records.get(id) ?? null; }
}
