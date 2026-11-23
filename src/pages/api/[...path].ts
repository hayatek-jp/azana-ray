// SPDX-FileCopyrightText: 2026 KATO Hayate <dev@hayatek.jp>
// SPDX-License-Identifier: AGPL-3.0-only

export const prerender = false;

import { Hono } from 'hono';
import { env } from 'cloudflare:workers';

import urls from '@/server/urls';
import analytics from '@/server/analytics';

import type { APIRoute } from 'astro';

const app = new Hono<{ Bindings: Cloudflare.Env }>().basePath('/api');

const route = app
    .route('/urls', urls)
    .route('/analytics', analytics);

export const ALL: APIRoute = async ({ request, locals }) => {
    return app.fetch(request, env, locals.cfContext);
};

export type AppType = typeof route;
