// SPDX-FileCopyrightText: 2026 KATO Hayate <dev@hayatek.jp>
// SPDX-License-Identifier: AGPL-3.0-only

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';

import { randomStringId } from '@/utils/identity';


const app = new Hono<{ Bindings: Cloudflare.Env }>()
    .get('/',
        async (c) => {
            const result: { urls: { key: string; destination: string }[] } = { urls: [] };
            let list = await c.env.URLS.list();
            while (true) {
                if (list.keys.length === 0) {
                    return c.json(result);
                }
                const pairs = await c.env.URLS.get(list.keys.map((k) => k.name));
                result.urls = result.urls.concat(
                    [...pairs]
                        .filter((entry): entry is [string, string] => entry[1] !== null)
                        .map(([key, destination]) => ({ key, destination })),
                );
                if (list.list_complete) {
                    break;
                } else {
                    list = await c.env.URLS.list({ cursor: list.cursor });
                }
            }
            return c.json(result);
        },
    )
    .post('/',
        zValidator('json', z.object({
            destination: z.url(),
        })),
        async (c) => {
            let key;
            do {
                key = randomStringId(6);
            } while (await c.env.URLS.get(key) !== null);
            const { destination } = c.req.valid('json');
            await c.env.URLS.put(key, destination);
            return c.json({ message: 'URL stored successfully.', key }, 201);
        },
    )
    .get('/:key',
        async (c) => {
            let { key } = c.req.param();
            key = key.toLowerCase();
            const destination = await c.env.URLS.get(key);
            if (!destination) return c.json({ error: '404 Not Found' }, 404);
            return c.json({ destination });
        },
    )
    .put('/:key',
        zValidator('json', z.object({
            destination: z.url(),
        })),
        async (c) => {
            let { key } = c.req.param();
            key = key.toLowerCase();
            const { destination } = c.req.valid('json');
            await c.env.URLS.put(key, destination);
            return c.json({ message: 'URL stored successfully.' });
        },
    )
    .delete('/:key',
        async (c) => {
            let { key } = c.req.param();
            key = key.toLowerCase();
            // If it is completely removed, there may be conflicts in the future.
            await c.env.URLS.put(key, 'disabled:' + await c.env.URLS.get(key));
            return c.json({ message: 'URL deleted successfully.' });
        }
    );


export default app;
