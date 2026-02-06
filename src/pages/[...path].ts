// SPDX-FileCopyrightText: 2026 KATO Hayate <dev@hayatek.jp>
// SPDX-License-Identifier: AGPL-3.0-only

export const prerender = false;

import { Hono } from 'hono';
import type { APIRoute } from 'astro';

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
 */
app.get('/:key', async (c) => {
    const { key } = c.req.param();
    const destination = await c.env.URLS.get(key.toLowerCase());
    if (!destination) return c.text('404 Not Found', 404);
    if (destination.startsWith('disabled:')) return c.text('410 Gone', 410);
    return c.redirect(destination, 307);
});


export const ALL: APIRoute = async ({ request, locals }) => {
    return app.fetch(request, locals.runtime.env);
};
