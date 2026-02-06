import { hc } from 'hono/client';

import type { AppType } from '@/pages/api/[...path]';

export const api = hc<AppType>('/').api;
