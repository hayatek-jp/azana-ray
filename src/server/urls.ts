// SPDX-FileCopyrightText: 2026 KATO Hayate <dev@hayatek.jp>
// SPDX-License-Identifier: AGPL-3.0-only

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';

import { randomStringId } from '@/utils/identity';
import type { UrlMeta } from '@/types/url';
import { countLogsForKey, getDashboardStats, getHostGroups, getUrls } from '@/server/stats';


const app = new Hono<{ Bindings: Cloudflare.Env }>()
    /**
     * GET /  — 全URL一覧 (メタデータ・アクセス数つき)
     */
    .get('/',
        async (c) => {
            const urls = await getUrls(c.env);
            return c.json({ urls });
        },
    )
    /**
     * GET /groups  — ホスト名ごとにグループ化した一覧
     */
    .get('/groups',
        async (c) => {
            const groups = await getHostGroups(c.env);
            return c.json({ groups });
        },
    )
    /**
     * GET /stats  — ダッシュボード用統計
     */
    .get('/stats',
        async (c) => {
            const stats = await getDashboardStats(c.env);
            return c.json({
                totalUrls: stats.totalUrls,
                totalClicks: stats.totalClicks,
                activeUrls: stats.totalUrls,
                todayClicks: stats.todayClicks,
                weeklyClicks: stats.weeklyClicks,
                monthlyClicks: stats.monthlyClicks,
                hostGroupCount: stats.hostGroupCount,
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
            const totalClicks = await countLogsForKey(c.env.ACCESS_LOGS, key);
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


export default app;
