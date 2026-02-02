export const prerender = false;

import { Hono } from 'hono';
import type { APIRoute } from 'astro';

const app = new Hono<{ Bindings: Cloudflare.Env }>().basePath('/api');

app.get('/hello', (c) => {
    return c.json({ message: 'Hello from Hono!' });
});

export const ALL: APIRoute = async ({ request }) => {
    return app.fetch(request);
};
