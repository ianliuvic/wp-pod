import type { CatalogStore } from './catalog-store.js';
import { config } from './config.js';

/** Categories tracked in the archive (pod-assets manifest source categories). */
export const SHELF_CATEGORIES = [
  { id: '1394', label: "Women's Clothing" },
  { id: '1355', label: "Men's Clothing" },
  { id: '1315', label: "Kids' Clothing" },
  { id: '1443', label: 'Shoes, Hats & Accessories' },
  { id: '207', label: 'Home & Living' },
  { id: '227', label: 'Bags & Totes' },
  { id: '232', label: '3C Electronics Accessories' },
  { id: '356', label: 'Jewelry & Accessories' }
];

export type ShelfProductRef = {
  id: string;
  name: string;
  categories: Array<{ id: string | null; label: string }>;
};

export type ShelfReport = {
  checkedAt: string;
  catalogCount: number;
  listedCount: number;
  categories: Array<{ id: string; label: string; current: number }>;
  delisted: ShelfProductRef[];
  restored: ShelfProductRef[];
  newListed: ShelfProductRef[];
};

type FetchLike = typeof fetch;
type Logger = (obj: unknown, msg?: string) => void;

/** SDS category listing API (public; no account token required). */
export async function fetchListedProducts(fetcher: FetchLike = fetch): Promise<{
  ids: Set<string>;
  byId: Map<string, { name: string; categoryIds: string[] }>;
  perCategory: Map<string, number>;
}> {
  const ids = new Set<string>();
  const byId = new Map<string, { name: string; categoryIds: string[] }>();
  const perCategory = new Map<string, number>();
  for (const category of SHELF_CATEGORIES) {
    let page = 1;
    let total: number | null = null;
    let fetched = 0;
    while (total === null || fetched < total) {
      const url =
        `https://mapi.sdspod.com/products/page?size=200&page=${page}&categoryId=${category.id}` +
        '&preciseSearch=0&shipmentArea=CN&isOverseas=CN&sortType=desc&sortField=generalHeat';
      const response = await fetcher(url, {
        headers: {
          Referer: 'https://www.sdsdiy.com/',
          Origin: 'https://www.sdsdiy.com',
          'User-Agent': 'Mozilla/5.0 wp-pod shelf-check'
        },
        signal: AbortSignal.timeout(60_000)
      });
      if (!response.ok) throw new Error(`sds_list_${response.status}:${category.id}`);
      const body = (await response.json()) as {
        totalCount?: number;
        items?: Array<{ id?: number | string; name?: string; categories?: Array<{ id?: number | string }> }>;
      };
      total = Number(body.totalCount) || 0;
      const items = body.items ?? [];
      fetched += items.length;
      for (const item of items) {
        const id = String(item.id);
        ids.add(id);
        byId.set(id, {
          name: String(item.name ?? id),
          categoryIds: (item.categories ?? []).map((entry) => String(entry.id))
        });
      }
      perCategory.set(category.id, total);
      page += 1;
      if (page > 30) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  return { ids, byId, perCategory };
}

/** Compares the SDS listings against the catalogue and stores the transitions. */
export async function runShelfCheck(
  catalog: CatalogStore,
  options: { fetcher?: FetchLike; notify?: boolean; log?: Logger } = {}
): Promise<ShelfReport> {
  const log: Logger = options.log ?? (() => undefined);
  const snapshot = await catalog.shelfSnapshot();
  const known = new Set(snapshot.map((item) => item.id));
  const listed = await fetchListedProducts(options.fetcher ?? fetch);

  const delisted: ShelfProductRef[] = [];
  const restored: ShelfProductRef[] = [];
  for (const item of snapshot) {
    if (!listed.ids.has(item.id)) {
      delisted.push({ id: item.id, name: item.name, categories: item.categories });
    } else if (item.shelfStatus === 'delisted') {
      restored.push({ id: item.id, name: item.name, categories: item.categories });
    }
  }
  const newListed: ShelfProductRef[] = [...listed.ids]
    .filter((id) => !known.has(id))
    .map((id) => ({ id, name: listed.byId.get(id)?.name ?? id, categories: [] }));

  const transitions = await catalog.applyShelfStatus({
    delistedIds: delisted.map((item) => item.id),
    restoredIds: restored.map((item) => item.id)
  });

  const report: ShelfReport = {
    checkedAt: new Date().toISOString(),
    catalogCount: snapshot.length,
    listedCount: listed.ids.size,
    categories: SHELF_CATEGORIES.map((category) => ({
      ...category,
      current: listed.perCategory.get(category.id) ?? 0
    })),
    delisted,
    restored,
    newListed
  };
  log(
    {
      transitions,
      delisted: delisted.length,
      restored: restored.length,
      newListed: newListed.length,
      checkedAt: report.checkedAt
    },
    'shelf check finished'
  );
  if (options.notify !== false) {
    try {
      await sendFeishuShelfCard(report);
    } catch (error) {
      log({ err: String(error) }, 'feishu shelf card failed');
    }
  }
  return report;
}

function formatTime(iso: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(new Date(iso));
}

function productLines(items: ShelfProductRef[], limit: number): string {
  const shown = items.slice(0, limit);
  const lines = shown.map((item) => {
    const category = item.categories[0]?.label ? `（${item.categories[0].label}）` : '';
    return `• ${item.id} ${item.name}${category}`;
  });
  if (items.length > shown.length) lines.push(`… 其余 ${items.length - shown.length} 款`);
  return lines.join('\n');
}

/** Sends the weekly shelf card through the shared Feishu bot. */
export async function sendFeishuShelfCard(report: ShelfReport): Promise<boolean> {
  const appId = config.FEISHU_APP_ID;
  const appSecret = config.FEISHU_APP_SECRET;
  const chatId = config.FEISHU_CHAT_ID;
  if (!appId || !appSecret || !chatId) return false;

  const tokenResponse = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    signal: AbortSignal.timeout(20_000)
  });
  const tokenBody = (await tokenResponse.json()) as { code?: number; tenant_access_token?: string; msg?: string };
  if (!tokenResponse.ok || tokenBody.code !== 0 || !tokenBody.tenant_access_token) {
    throw new Error(`feishu_token_failed:${tokenBody.msg ?? tokenResponse.status}`);
  }

  const severity = report.delisted.length ? 'red' : report.newListed.length ? 'orange' : 'green';
  const icon = report.delisted.length ? '🔴' : report.newListed.length ? '🟠' : '✅';
  const sections: Array<Record<string, unknown>> = [
    {
      tag: 'div',
      fields: [
        { is_short: true, text: { tag: 'lark_md', content: `**检查时间**\n${formatTime(report.checkedAt)}` } },
        { is_short: true, text: { tag: 'lark_md', content: `**目录商品**\n${report.catalogCount} 款` } },
        { is_short: true, text: { tag: 'lark_md', content: `**SDS 在架**\n${report.listedCount} 款` } },
        {
          is_short: true,
          text: {
            tag: 'lark_md',
            content: `**变化**\n下架 ${report.delisted.length} · 恢复 ${report.restored.length} · 新上 ${report.newListed.length}`
          }
        }
      ]
    },
    { tag: 'hr' }
  ];
  if (report.delisted.length) {
    sections.push({
      tag: 'div',
      text: { tag: 'lark_md', content: `**已下架（${report.delisted.length}）**\n${productLines(report.delisted, 20)}\n\n已在数据表标记为已下架，pod-orders 款式库会显示「已下架」标识。` }
    });
  }
  if (report.restored.length) {
    sections.push({
      tag: 'div',
      text: { tag: 'lark_md', content: `**恢复上架（${report.restored.length}）**\n${productLines(report.restored, 10)}\n\n已自动恢复为在架状态。` }
    });
  }
  if (report.newListed.length) {
    sections.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `**新上架未采集（${report.newListed.length}）**\n${productLines(report.newListed, 20)}\n\n⚠️ 请运行 SDS 采集流程，把新品补进归档与目录。`
      }
    });
  }
  if (!report.delisted.length && !report.restored.length && !report.newListed.length) {
    sections.push({ tag: 'div', text: { tag: 'lark_md', content: '本次检查没有发现上下架变化。' } });
  }
  sections.push({
    tag: 'note',
    elements: [
      {
        tag: 'plain_text',
        content: `分类在架数：${report.categories.map((category) => `${category.label} ${category.current}`).join(' · ')}`
      }
    ]
  });

  const card = {
    config: { wide_screen_mode: true },
    header: {
      template: severity,
      title: { tag: 'plain_text', content: `${icon} [POD Shelf] 每周上下架检查` }
    },
    elements: sections
  };

  const response = await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id', {
    method: 'POST',
    headers: { authorization: `Bearer ${tokenBody.tenant_access_token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ receive_id: chatId, msg_type: 'interactive', content: JSON.stringify(card) }),
    signal: AbortSignal.timeout(20_000)
  });
  const body = (await response.json()) as { code?: number; msg?: string };
  if (!response.ok || body.code !== 0) throw new Error(`feishu_message_failed:${body.msg ?? response.status}`);
  return true;
}
