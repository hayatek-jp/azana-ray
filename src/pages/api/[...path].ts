// SPDX-FileCopyrightText: 2026 KATO Hayate <dev@hayatek.jp>
// SPDX-License-Identifier: AGPL-3.0-only

export const prerender = false;

import { Hono } from 'hono';

import urls from '@/server/urls';

import type { APIRoute } from 'astro';

const app = new Hono<{ Bindings: Cloudflare.Env }>().basePath('/api');

const route = app
    .route('/urls', urls);

export const ALL: APIRoute = async ({ request, locals }) => {
    return app.fetch(request, locals.runtime.env);
};

export type AppType = typeof route;
