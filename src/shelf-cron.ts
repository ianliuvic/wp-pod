/**
 * Weekly SDS shelf check, run by a Coolify scheduled task:
 *   node dist/shelf-cron.js
 *
 * Fetches the public SDS category listings, compares them with the catalogue
 * index, stores delisted/restored transitions and sends the Feishu card.
 */
import { CatalogStore } from './catalog-store.js';
import { config } from './config.js';
import { runShelfCheck } from './shelf.js';

const log = (obj: unknown, msg?: string) =>
  console.log(JSON.stringify({ ...(typeof obj === 'object' && obj ? obj : { detail: obj }), msg: msg ?? '', at: new Date().toISOString() }));

if (!config.DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const catalog = new CatalogStore(config.DATABASE_URL, 'pod_products');
try {
  await catalog.init();
  const report = await runShelfCheck(catalog, { log });
  console.log(
    JSON.stringify({
      ok: true,
      checkedAt: report.checkedAt,
      catalogCount: report.catalogCount,
      listedCount: report.listedCount,
      delisted: report.delisted.length,
      restored: report.restored.length,
      newListed: report.newListed.length
    })
  );
  process.exit(0);
} catch (error) {
  console.error('shelf check failed', error);
  process.exit(1);
}
