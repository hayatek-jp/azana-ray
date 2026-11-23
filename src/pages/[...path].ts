// SPDX-FileCopyrightText: 2026 KATO Hayate <dev@hayatek.jp>
// SPDX-License-Identifier: AGPL-3.0-only

export const prerender = false;

import { Hono } from 'hono';
import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { recordAccessLog } from '@/server/analytics';
import { parseBrowser, parseOs, parseDevice, parseReferrerDomain } from '@/utils/ua';
import type { AccessLog } from '@/types/url';

const app = new Hono<{ Bindings: Cloudflare.Env }>().basePath('/');


/**
 * Fallback redirect to URL stored in KV namespace.
 */
app.get('/', async (c) => {
    const destination = await c.env.URLS.get('fallback');
    if (!destination) return c.text('404 Not Found', 404);
    return c.redirect(destination, 307);
});


/**
 * Redirect based on the key provided in the path.
 * Records access log using cf object for geo/network data.
 */
app.get('/:key', async (c) => {
    const { key } = c.req.param();
    const lowerKey = key.toLowerCase();
    const destination = await c.env.URLS.get(lowerKey);
    if (!destination) return c.text('404 Not Found', 404);
    if (destination.startsWith('disabled:')) return c.text('410 Gone', 410);

    // アクセスログを非同期で記録 (リダイレクトをブロックしない)
    const ua = c.req.header('user-agent') ?? '';
    const referrer = c.req.header('referer') ?? '';
    const cf = (c.req.raw as unknown as { cf?: Record<string, unknown> }).cf ?? {};

    const log: AccessLog = {
        key: lowerKey,
        timestamp: new Date().toISOString(),
        referrer: parseReferrerDomain(referrer),
        userAgent: ua,
        country: (cf.country as string) ?? '',
        city: (cf.city as string) ?? '',
        continent: (cf.continent as string) ?? '',
        timezone: (cf.timezone as string) ?? '',
        asn: (cf.asn as number) ?? 0,
        device: parseDevice(ua),
        browser: parseBrowser(ua),
        os: parseOs(ua),
    };

    c.executionCtx.waitUntil(recordAccessLog(c.env.ACCESS_LOGS, log));

    return c.redirect(destination, 307);
});


export const ALL: APIRoute = async ({ request, locals }) => {
    return app.fetch(request, env, locals.cfContext);
};
