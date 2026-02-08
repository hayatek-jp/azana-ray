// SPDX-FileCopyrightText: 2026 KATO Hayate <dev@hayatek.jp>
// SPDX-License-Identifier: AGPL-3.0-only

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';

import { randomStringId } from '@/utils/identity';
import type { UrlMeta, ShortenedUrl, HostGroup, AccessLog } from '@/types/url';


const app = new Hono<{ Bindings: Cloudflare.Env }>()
    /**
     * GET /  — 全URL一覧 (メタデータ・アクセス数つき)
     */
    .get('/',
        async (c) => {
            const urls: ShortenedUrl[] = [];
            let list = await c.env.URLS.list();
            while (true) {
                for (const k of list.keys) {
                    const destination = await c.env.URLS.get(k.name);
                    if (destination === null || destination.startsWith('disabled:')) continue;
                    const metaRaw = await c.env.URL_META.get(k.name);
                    const meta: UrlMeta = metaRaw
                        ? JSON.parse(metaRaw)
                        : { comment: '', createdAt: '' };
                    const clickCount = await countAccessLogs(c.env.ACCESS_LOGS, k.name);
                    urls.push({
                        key: k.name,
                        destination,
                        comment: meta.comment,
                        createdAt: meta.createdAt,
                        totalClicks: clickCount,
                    });
                }
                if (list.list_complete) break;
                list = await c.env.URLS.list({ cursor: list.cursor });
            }
            return c.json({ urls });
        },
    )
    /**
     * GET /groups  — ホスト名ごとにグループ化した一覧
     */
    .get('/groups',
        async (c) => {
            const map = new Map<string, { urlCount: number; totalClicks: number }>();
            let list = await c.env.URLS.list();
            while (true) {
                for (const k of list.keys) {
                    const destination = await c.env.URLS.get(k.name);
                    if (destination === null || destination.startsWith('disabled:')) continue;
                    try {
                        const hostname = new URL(destination).hostname;
                        const existing = map.get(hostname) ?? { urlCount: 0, totalClicks: 0 };
                        existing.urlCount++;
                        existing.totalClicks += await countAccessLogs(c.env.ACCESS_LOGS, k.name);
                        map.set(hostname, existing);
                    } catch { /* skip invalid URLs */ }
                }
                if (list.list_complete) break;
                list = await c.env.URLS.list({ cursor: list.cursor });
            }
            const groups: HostGroup[] = [...map.entries()]
                .map(([hostname, data]) => ({ hostname, ...data }))
                .sort((a, b) => b.totalClicks - a.totalClicks);
            return c.json({ groups });
        },
    )
    /**
     * GET /stats  — ダッシュボード用統計
     */
    .get('/stats',
        async (c) => {
            let totalUrls = 0;
            let totalClicks = 0;
            const hostnames = new Set<string>();

            let list = await c.env.URLS.list();
            while (true) {
                for (const k of list.keys) {
                    const destination = await c.env.URLS.get(k.name);
                    if (destination === null || destination.startsWith('disabled:')) continue;
                    totalUrls++;
                    const clicks = await countAccessLogs(c.env.ACCESS_LOGS, k.name);
                    totalClicks += clicks;
                    try { hostnames.add(new URL(destination).hostname); } catch { /* skip */ }
                }
                if (list.list_complete) break;
                list = await c.env.URLS.list({ cursor: list.cursor });
            }

            // 期間別クリック数
            const now = Date.now();
            const todayStart = new Date().setHours(0, 0, 0, 0);
            const weekStart = now - 7 * 24 * 60 * 60 * 1000;
            const monthStart = now - 30 * 24 * 60 * 60 * 1000;
            const allLogs = await getAllAccessLogs(c.env.ACCESS_LOGS);
            let todayClicks = 0, weeklyClicks = 0, monthlyClicks = 0;
            for (const log of allLogs) {
                const ts = new Date(log.timestamp).getTime();
                if (ts >= todayStart) todayClicks++;
                if (ts >= weekStart) weeklyClicks++;
                if (ts >= monthStart) monthlyClicks++;
            }

            return c.json({
                totalUrls,
                totalClicks,
                activeUrls: totalUrls,
                todayClicks,
                weeklyClicks,
                monthlyClicks,
                hostGroupCount: hostnames.size,
            });
        },
    )
    /**
     * POST /  — 新規URL作成 (comment対応)
     */
    .post('/',
        zValidator('json', z.object({
            destination: z.url(),
            comment: z.string().optional().default(''),
            customKey: z.string().regex(/^[a-z0-9\-]*$/).optional(),
        })),
        async (c) => {
            const { destination, comment, customKey } = c.req.valid('json');
            let key: string;
            if (customKey) {
                if (await c.env.URLS.get(customKey) !== null) {
                    return c.json({ error: 'Key already exists.' }, 409);
                }
                key = customKey;
            } else {
                do {
                    key = randomStringId(6);
                } while (await c.env.URLS.get(key) !== null);
            }
            await c.env.URLS.put(key, destination);
            const meta: UrlMeta = {
                comment,
                createdAt: new Date().toISOString(),
            };
            await c.env.URL_META.put(key, JSON.stringify(meta));
            return c.json({ message: 'URL stored successfully.', key }, 201);
        },
    )
    /**
     * GET /:key  — URL詳細取得
     */
    .get('/:key',
        async (c) => {
            let { key } = c.req.param();
            key = key.toLowerCase();
            const destination = await c.env.URLS.get(key);
            if (!destination || destination.startsWith('disabled:')) {
                return c.json({ error: '404 Not Found' }, 404);
            }
            const metaRaw = await c.env.URL_META.get(key);
            const meta: UrlMeta = metaRaw
                ? JSON.parse(metaRaw)
                : { comment: '', createdAt: '' };
            const totalClicks = await countAccessLogs(c.env.ACCESS_LOGS, key);
            return c.json({
                key,
                destination,
                comment: meta.comment,
                createdAt: meta.createdAt,
                totalClicks,
            });
        },
    )
    /**
     * PUT /:key  — URL更新 (comment対応)
     */
    .put('/:key',
        zValidator('json', z.object({
            destination: z.url(),
            comment: z.string().optional(),
        })),
        async (c) => {
            let { key } = c.req.param();
            key = key.toLowerCase();
            const existing = await c.env.URLS.get(key);
            if (!existing || existing.startsWith('disabled:')) {
                return c.json({ error: '404 Not Found' }, 404);
            }
            const { destination, comment } = c.req.valid('json');
            await c.env.URLS.put(key, destination);
            if (comment !== undefined) {
                const metaRaw = await c.env.URL_META.get(key);
                const meta: UrlMeta = metaRaw
                    ? JSON.parse(metaRaw)
                    : { comment: '', createdAt: new Date().toISOString() };
                meta.comment = comment;
                await c.env.URL_META.put(key, JSON.stringify(meta));
            }
            return c.json({ message: 'URL updated successfully.' });
        },
    )
    /**
     * DELETE /:key  — URL無効化
     */
    .delete('/:key',
        async (c) => {
            let { key } = c.req.param();
            key = key.toLowerCase();
            const current = await c.env.URLS.get(key);
            if (!current) return c.json({ error: '404 Not Found' }, 404);
            await c.env.URLS.put(key, 'disabled:' + current);
            return c.json({ message: 'URL deleted successfully.' });
        }
    );


/**
 * 特定キーのアクセスログ数をカウント
 */
async function countAccessLogs(kv: KVNamespace, key: string): Promise<number> {
    let count = 0;
    let list = await kv.list({ prefix: `log:${key}:` });
    count += list.keys.length;
    while (!list.list_complete) {
        list = await kv.list({ prefix: `log:${key}:`, cursor: list.cursor });
        count += list.keys.length;
    }
    return count;
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


export default app;
