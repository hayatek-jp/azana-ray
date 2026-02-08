// SPDX-FileCopyrightText: 2026 KATO Hayate <dev@hayatek.jp>
// SPDX-License-Identifier: AGPL-3.0-only

import { Hono } from 'hono';
import type { AccessLog } from '@/types/url';


/**
 * アクセスログ記録用ユーティリティ。
 * リダイレクト時に c.executionCtx.waitUntil() で非同期呼び出しする。
 */
export async function recordAccessLog(
    kv: KVNamespace,
    log: AccessLog,
): Promise<void> {
    const key = `log:${log.key}:${log.timestamp}`;
    await kv.put(key, JSON.stringify(log), {
        // 90日後に自動削除
        expirationTtl: 90 * 24 * 60 * 60,
    });
}


/**
 * 特定キーのアクセスログを全取得
 */
async function getAccessLogsByKey(kv: KVNamespace, urlKey: string): Promise<AccessLog[]> {
    const logs: AccessLog[] = [];
    let list = await kv.list({ prefix: `log:${urlKey}:` });
    while (true) {
        for (const k of list.keys) {
            const raw = await kv.get(k.name);
            if (raw) {
                try { logs.push(JSON.parse(raw)); } catch { /* skip */ }
            }
        }
        if (list.list_complete) break;
        list = await kv.list({ prefix: `log:${urlKey}:`, cursor: list.cursor });
    }
    return logs;
}

/**
 * 全アクセスログを取得
 */
async function getAllAccessLogs(kv: KVNamespace): Promise<AccessLog[]> {
    const logs: AccessLog[] = [];
    let list = await kv.list({ prefix: 'log:' });
    while (true) {
        for (const k of list.keys) {
            const raw = await kv.get(k.name);
            if (raw) {
                try { logs.push(JSON.parse(raw)); } catch { /* skip */ }
            }
        }
        if (list.list_complete) break;
        list = await kv.list({ prefix: 'log:', cursor: list.cursor });
    }
    return logs;
}

/**
 * 統計を集計するヘルパー
 */
function computeDistribution(items: string[]): { label: string; count: number; percentage: number }[] {
    const total = items.length;
    if (total === 0) return [];
    const map = new Map<string, number>();
    for (const item of items) {
        map.set(item, (map.get(item) ?? 0) + 1);
    }
    return [...map.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([label, count]) => ({
            label,
            count,
            percentage: Math.round((count / total) * 100),
        }));
}

function computeDailyStats(logs: AccessLog[], days: number) {
    const now = new Date();
    const stats = new Map<string, number>();
    for (let i = days - 1; i >= 0; i--) {
        const d = new Date(now);
        d.setDate(d.getDate() - i);
        stats.set(d.toISOString().slice(0, 10), 0);
    }
    for (const log of logs) {
        const date = log.timestamp.slice(0, 10);
        if (stats.has(date)) {
            stats.set(date, stats.get(date)! + 1);
        }
    }
    return [...stats.entries()].map(([date, clicks]) => ({ date, clicks }));
}

function computeHourlyStats(logs: AccessLog[]) {
    const hours = new Array(24).fill(0);
    for (const log of logs) {
        const h = new Date(log.timestamp).getHours();
        hours[h]++;
    }
    return hours.map((count, hour) => ({ hour, count }));
}


const app = new Hono<{ Bindings: Cloudflare.Env }>()
    /**
     * GET /daily  — 全体の日別アクセス統計 (直近30日)
     */
    .get('/daily',
        async (c) => {
            const logs = await getAllAccessLogs(c.env.ACCESS_LOGS);
            const dailyStats = computeDailyStats(logs, 30);
            return c.json({ dailyStats });
        },
    )
    /**
     * GET /group/:hostname  — ホスト名グループのアクセス解析
     */
    .get('/group/:hostname',
        async (c) => {
            const { hostname } = c.req.param();

            // このホストに属するURLキーを収集
            const urlKeys: { key: string; destination: string }[] = [];
            let list = await c.env.URLS.list();
            while (true) {
                for (const k of list.keys) {
                    const destination = await c.env.URLS.get(k.name);
                    if (destination === null || destination.startsWith('disabled:')) continue;
                    try {
                        if (new URL(destination).hostname === hostname) {
                            urlKeys.push({ key: k.name, destination });
                        }
                    } catch { /* skip */ }
                }
                if (list.list_complete) break;
                list = await c.env.URLS.list({ cursor: list.cursor });
            }

            if (urlKeys.length === 0) {
                return c.json({ error: 'No URLs found for this hostname.' }, 404);
            }

            // 全ログ収集
            const allLogs: AccessLog[] = [];
            for (const url of urlKeys) {
                const logs = await getAccessLogsByKey(c.env.ACCESS_LOGS, url.key);
                allLogs.push(...logs);
            }

            const totalClicks = allLogs.length;
            // ユニークビジター: UA + country の組み合わせで近似
            const uniqueSet = new Set(allLogs.map((l) => `${l.userAgent}:${l.country}`));

            // URLごとのクリック数
            const clicksByKey = new Map<string, number>();
            for (const log of allLogs) {
                clicksByKey.set(log.key, (clicksByKey.get(log.key) ?? 0) + 1);
            }

            const topUrls = urlKeys
                .map((u) => ({
                    key: u.key,
                    destination: u.destination,
                    clicks: clicksByKey.get(u.key) ?? 0,
                }))
                .sort((a, b) => b.clicks - a.clicks);

            return c.json({
                hostname,
                totalClicks,
                uniqueVisitors: uniqueSet.size,
                dailyStats: computeDailyStats(allLogs, 30),
                hourlyStats: computeHourlyStats(allLogs),
                referrerStats: computeDistribution(allLogs.map((l) => l.referrer || 'ダイレクト')),
                deviceStats: computeDistribution(allLogs.map((l) => l.device)),
                browserStats: computeDistribution(allLogs.map((l) => l.browser)),
                osStats: computeDistribution(allLogs.map((l) => l.os)),
                countryStats: computeDistribution(allLogs.map((l) => l.country || '不明')),
                topUrls,
            });
        },
    );


export default app;
