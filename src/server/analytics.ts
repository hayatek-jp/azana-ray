// SPDX-FileCopyrightText: 2026 KATO Hayate <dev@hayatek.jp>
// SPDX-License-Identifier: AGPL-3.0-only

import { Hono } from 'hono';
import type { AccessLog } from '@/types/url';
import { getDailyStats, getGroupAnalytics, toAccessLogMeta } from '@/server/stats';


/**
 * アクセスログ記録用ユーティリティ。
 * リダイレクト時に c.executionCtx.waitUntil() で非同期呼び出しする。
 *
 * 集計で使う属性はメタデータにも保存し、list() だけで取得できるようにする。
 */
export async function recordAccessLog(
    kv: KVNamespace,
    log: AccessLog,
): Promise<void> {
    const key = `log:${log.key}:${log.timestamp}`;
    await kv.put(key, JSON.stringify(log), {
        // 90日後に自動削除
        expirationTtl: 90 * 24 * 60 * 60,
        metadata: toAccessLogMeta(log),
    });
}


const app = new Hono<{ Bindings: Cloudflare.Env }>()
    /**
     * GET /daily  — 全体の日別アクセス統計 (直近30日)
     */
    .get('/daily',
        async (c) => {
            const dailyStats = await getDailyStats(c.env, 30);
            return c.json({ dailyStats });
        },
    )
    /**
     * GET /group/:hostname  — ホスト名グループのアクセス解析
     */
    .get('/group/:hostname',
        async (c) => {
            const { hostname } = c.req.param();
            const analytics = await getGroupAnalytics(c.env, hostname);
            if (analytics === null) {
                return c.json({ error: 'No URLs found for this hostname.' }, 404);
            }
            return c.json(analytics);
        },
    );


export default app;
