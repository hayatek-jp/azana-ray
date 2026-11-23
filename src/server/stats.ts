// SPDX-FileCopyrightText: 2026 KATO Hayate <dev@hayatek.jp>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 統計データ取得・集計の共通モジュール。
 *
 * パフォーマンス上の方針:
 * - アクセスログのキーは `log:<短縮キー>:<ISO 8601 タイムスタンプ>` 形式なので、
 *   件数・日別/期間別の集計は list() の結果 (キー名) だけで行い、値は読まない。
 * - 解析に必要な属性 (リファラー・デバイス等) はログ書き込み時に KV のメタデータにも保存し、
 *   list() で一括取得する。メタデータを持たない旧形式のログのみ一括 get() で値を読む。
 * - 独立した KV リクエストは並列に (同時実行数を制限して) 発行する。
 */

import type { AccessLog, DailyStats, HostGroup, ShortenedUrl, UrlMeta } from '@/types/url';


type Env = Pick<Cloudflare.Env, 'URLS' | 'URL_META' | 'ACCESS_LOGS'>;

/** list() 1回あたりの最大取得件数 */
const LIST_LIMIT = 1000;
/** 一括 get() で指定できる最大キー数 */
const BULK_GET_LIMIT = 100;
/** 同時に発行する KV リクエスト数の上限 */
const CONCURRENCY = 6;
/** アクセスログのキーのプレフィックス */
const LOG_PREFIX = 'log:';
/** メタデータに保存するリファラーの最大長 (メタデータは 1024 バイト制限) */
const MAX_REFERRER_LENGTH = 256;


/* ------------------------------------------------------------------ */
/* アクセスログのメタデータ                                            */
/* ------------------------------------------------------------------ */

/**
 * アクセスログの KV メタデータ。list() で値を読まずに取得できる。
 * サイズ制限 (1024 バイト) があるため、キー名は短縮している。
 */
export interface AccessLogMeta {
    /** リファラー */
    r: string;
    /** 国 */
    c: string;
    /** デバイスタイプ */
    d: AccessLog['device'];
    /** ブラウザ名 */
    b: string;
    /** OS名 */
    o: string;
    /** User-Agent のハッシュ (ユニークビジター近似用) */
    u: string;
}

/**
 * 集計に必要な情報だけを持つアクセスログ
 */
export interface LogSummary {
    key: string;
    timestamp: string;
    referrer: string;
    country: string;
    device: AccessLog['device'];
    browser: string;
    os: string;
    /** ユニークビジター判定用 ID (UA ハッシュ + 国) */
    visitorId: string;
}

/**
 * list() で得たアクセスログのキー情報
 */
interface LogEntry {
    name: string;
    key: string;
    timestamp: string;
    meta?: AccessLogMeta;
}

/**
 * アクセスログから KV メタデータを生成する
 */
export function toAccessLogMeta(log: AccessLog): AccessLogMeta {
    return {
        r: log.referrer.slice(0, MAX_REFERRER_LENGTH),
        c: log.country,
        d: log.device,
        b: log.browser,
        o: log.os,
        u: hashString(log.userAgent),
    };
}

/**
 * 高速な非暗号学的ハッシュ (cyrb53)。53bit の値を base36 文字列で返す。
 */
function hashString(str: string): string {
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) {
        const ch = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

function isAccessLogMeta(value: unknown): value is AccessLogMeta {
    return typeof value === 'object' && value !== null && typeof (value as AccessLogMeta).u === 'string';
}


/* ------------------------------------------------------------------ */
/* KV アクセスの低レベルヘルパー                                       */
/* ------------------------------------------------------------------ */

/**
 * 同時実行数を制限して非同期処理を実行する (結果は入力順)
 */
async function mapConcurrent<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const results = new Array<R>(items.length);
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const i = next++;
            results[i] = await fn(items[i]);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}

function chunk<T>(items: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < items.length; i += size) {
        chunks.push(items.slice(i, i + size));
    }
    return chunks;
}

/**
 * プレフィックスに一致するキーを (メタデータ付きで) すべて列挙する
 */
async function listAllKeys<M>(kv: KVNamespace, prefix?: string): Promise<KVNamespaceListKey<M>[]> {
    const keys: KVNamespaceListKey<M>[] = [];
    let cursor: string | undefined;
    while (true) {
        const list = await kv.list<M>({ prefix, cursor, limit: LIST_LIMIT });
        keys.push(...list.keys);
        if (list.list_complete) break;
        cursor = list.cursor;
    }
    return keys;
}

/**
 * 複数キーの値を一括取得する (100件ずつ並列に取得)
 */
async function bulkGet(kv: KVNamespace, names: string[]): Promise<Map<string, string | null>> {
    const result = new Map<string, string | null>();
    const maps = await mapConcurrent(chunk(names, BULK_GET_LIMIT), CONCURRENCY, (c) => kv.get(c, 'text'));
    for (const map of maps) {
        for (const [k, v] of map) result.set(k, v);
    }
    return result;
}


/* ------------------------------------------------------------------ */
/* URL / アクセスログの取得                                            */
/* ------------------------------------------------------------------ */

interface ActiveUrl {
    key: string;
    destination: string;
}

/**
 * 有効な (無効化されていない) 短縮URLをすべて取得する
 */
async function getActiveUrls(env: Env): Promise<ActiveUrl[]> {
    const keys = await listAllKeys(env.URLS);
    const destinations = await bulkGet(env.URLS, keys.map((k) => k.name));
    const urls: ActiveUrl[] = [];
    for (const { name } of keys) {
        const destination = destinations.get(name);
        if (!destination || destination.startsWith('disabled:')) continue;
        urls.push({ key: name, destination });
    }
    return urls;
}

function hostnameOf(destination: string): string | null {
    try {
        return new URL(destination).hostname;
    } catch {
        return null;
    }
}

/**
 * ログのキー名 `log:<key>:<timestamp>` を分解する
 */
function parseLogName(name: string): { key: string; timestamp: string } | null {
    if (!name.startsWith(LOG_PREFIX)) return null;
    const sep = name.indexOf(':', LOG_PREFIX.length);
    if (sep < 0) return null;
    return { key: name.slice(LOG_PREFIX.length, sep), timestamp: name.slice(sep + 1) };
}

/**
 * アクセスログのキーを列挙する (値は読まない)
 */
async function scanLogs(kv: KVNamespace, prefix = LOG_PREFIX): Promise<LogEntry[]> {
    const keys = await listAllKeys<unknown>(kv, prefix);
    const entries: LogEntry[] = [];
    for (const k of keys) {
        const parsed = parseLogName(k.name);
        if (!parsed) continue;
        entries.push({
            name: k.name,
            ...parsed,
            meta: isAccessLogMeta(k.metadata) ? k.metadata : undefined,
        });
    }
    return entries;
}

/**
 * 指定した短縮キー群のアクセスログを列挙する (キーごとに並列で list)
 */
async function scanLogsForKeys(kv: KVNamespace, keys: string[]): Promise<LogEntry[]> {
    const results = await mapConcurrent(keys, CONCURRENCY, (key) => scanLogs(kv, `${LOG_PREFIX}${key}:`));
    return results.flat();
}

/**
 * ログエントリを集計用の LogSummary に変換する。
 * メタデータを持たない旧形式のログのみ値を一括取得する。
 */
async function resolveLogSummaries(kv: KVNamespace, entries: LogEntry[]): Promise<LogSummary[]> {
    const legacyNames = entries.filter((e) => !e.meta).map((e) => e.name);
    const legacyValues = legacyNames.length > 0 ? await bulkGet(kv, legacyNames) : new Map<string, string | null>();

    const summaries: LogSummary[] = [];
    for (const entry of entries) {
        if (entry.meta) {
            const m = entry.meta;
            summaries.push({
                key: entry.key,
                timestamp: entry.timestamp,
                referrer: m.r,
                country: m.c,
                device: m.d,
                browser: m.b,
                os: m.o,
                visitorId: `${m.u}:${m.c}`,
            });
            continue;
        }
        const raw = legacyValues.get(entry.name);
        if (!raw) continue;
        try {
            const log: AccessLog = JSON.parse(raw);
            summaries.push({
                key: log.key,
                timestamp: log.timestamp,
                referrer: log.referrer,
                country: log.country,
                device: log.device,
                browser: log.browser,
                os: log.os,
                visitorId: `${hashString(log.userAgent)}:${log.country}`,
            });
        } catch { /* skip */ }
    }
    return summaries;
}

function countByKey(entries: { key: string }[]): Map<string, number> {
    const counts = new Map<string, number>();
    for (const e of entries) counts.set(e.key, (counts.get(e.key) ?? 0) + 1);
    return counts;
}


/* ------------------------------------------------------------------ */
/* 集計ヘルパー                                                        */
/* ------------------------------------------------------------------ */

export interface DistributionItem {
    label: string;
    count: number;
    percentage: number;
}

function computeDistribution(items: string[]): DistributionItem[] {
    const total = items.length;
    if (total === 0) return [];
    const map = new Map<string, number>();
    for (const item of items) map.set(item, (map.get(item) ?? 0) + 1);
    return [...map.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([label, count]) => ({ label, count, percentage: Math.round((count / total) * 100) }));
}

function computeDailyStats(logs: { timestamp: string }[], days: number): DailyStats[] {
    const now = new Date();
    const stats = new Map<string, number>();
    for (let i = days - 1; i >= 0; i--) {
        const d = new Date(now);
        d.setDate(d.getDate() - i);
        stats.set(d.toISOString().slice(0, 10), 0);
    }
    for (const log of logs) {
        const date = log.timestamp.slice(0, 10);
        const current = stats.get(date);
        if (current !== undefined) stats.set(date, current + 1);
    }
    return [...stats.entries()].map(([date, clicks]) => ({ date, clicks }));
}

function computeHourlyStats(logs: { timestamp: string }[]): { hour: number; count: number }[] {
    const hours = new Array<number>(24).fill(0);
    for (const log of logs) {
        const h = new Date(log.timestamp).getHours();
        if (!Number.isNaN(h)) hours[h]++;
    }
    return hours.map((count, hour) => ({ hour, count }));
}

function computePeriodClicks(logs: { timestamp: string }[]) {
    const now = Date.now();
    const todayStart = new Date().setHours(0, 0, 0, 0);
    const weekStart = now - 7 * 24 * 60 * 60 * 1000;
    const monthStart = now - 30 * 24 * 60 * 60 * 1000;
    let todayClicks = 0, weeklyClicks = 0, monthlyClicks = 0;
    for (const log of logs) {
        const ts = new Date(log.timestamp).getTime();
        if (ts >= todayStart) todayClicks++;
        if (ts >= weekStart) weeklyClicks++;
        if (ts >= monthStart) monthlyClicks++;
    }
    return { todayClicks, weeklyClicks, monthlyClicks };
}

function groupByHostname(urls: ActiveUrl[], clicks: Map<string, number>): HostGroup[] {
    const map = new Map<string, { urlCount: number; totalClicks: number }>();
    for (const url of urls) {
        const hostname = hostnameOf(url.destination);
        if (hostname === null) continue;
        const existing = map.get(hostname) ?? { urlCount: 0, totalClicks: 0 };
        existing.urlCount++;
        existing.totalClicks += clicks.get(url.key) ?? 0;
        map.set(hostname, existing);
    }
    return [...map.entries()]
        .map(([hostname, data]) => ({ hostname, ...data }))
        .sort((a, b) => b.totalClicks - a.totalClicks);
}


/* ------------------------------------------------------------------ */
/* 公開 API                                                            */
/* ------------------------------------------------------------------ */

/**
 * 特定キーのアクセス数
 */
export async function countLogsForKey(kv: KVNamespace, key: string): Promise<number> {
    return (await listAllKeys(kv, `${LOG_PREFIX}${key}:`)).length;
}

/**
 * 直近 N 日間の日別アクセス数 (全URL)
 */
export async function getDailyStats(env: Env, days = 30): Promise<DailyStats[]> {
    return computeDailyStats(await scanLogs(env.ACCESS_LOGS), days);
}

/**
 * ダッシュボード用の統計一式
 */
export async function getDashboardStats(env: Env) {
    const [urls, logs] = await Promise.all([getActiveUrls(env), scanLogs(env.ACCESS_LOGS)]);
    const clicks = countByKey(logs);
    const hostGroups = groupByHostname(urls, clicks);
    const totalClicks = urls.reduce((sum, u) => sum + (clicks.get(u.key) ?? 0), 0);
    return {
        totalUrls: urls.length,
        totalClicks,
        ...computePeriodClicks(logs),
        hostGroupCount: hostGroups.length,
        hostGroups,
        dailyStats: computeDailyStats(logs, 30),
    };
}

/**
 * ホスト名ごとにグループ化したURL一覧
 */
export async function getHostGroups(env: Env): Promise<HostGroup[]> {
    const [urls, logs] = await Promise.all([getActiveUrls(env), scanLogs(env.ACCESS_LOGS)]);
    return groupByHostname(urls, countByKey(logs));
}

/**
 * メタデータ・アクセス数つきのURL一覧。hostname を指定するとそのホストのURLのみ返す。
 */
export async function getUrls(env: Env, hostname?: string): Promise<ShortenedUrl[]> {
    let urls = await getActiveUrls(env);
    if (hostname !== undefined) {
        urls = urls.filter((u) => hostnameOf(u.destination) === hostname);
    }
    if (urls.length === 0) return [];

    const keys = urls.map((u) => u.key);
    const [metas, logs] = await Promise.all([
        bulkGet(env.URL_META, keys),
        // ホスト指定時は該当キーのログだけを列挙し、全件一覧時はまとめて列挙する
        hostname !== undefined ? scanLogsForKeys(env.ACCESS_LOGS, keys) : scanLogs(env.ACCESS_LOGS),
    ]);
    const clicks = countByKey(logs);

    return urls.map((u) => {
        let meta: UrlMeta = { comment: '', createdAt: '' };
        const raw = metas.get(u.key);
        if (raw) {
            try { meta = JSON.parse(raw); } catch { /* skip */ }
        }
        return {
            key: u.key,
            destination: u.destination,
            comment: meta.comment,
            createdAt: meta.createdAt,
            totalClicks: clicks.get(u.key) ?? 0,
        };
    });
}

/**
 * ホスト名グループのアクセス解析。該当URLがなければ null。
 */
export async function getGroupAnalytics(env: Env, hostname: string) {
    const urls = (await getActiveUrls(env)).filter((u) => hostnameOf(u.destination) === hostname);
    if (urls.length === 0) return null;

    const entries = await scanLogsForKeys(env.ACCESS_LOGS, urls.map((u) => u.key));
    const logs = await resolveLogSummaries(env.ACCESS_LOGS, entries);

    const clicks = countByKey(logs);
    const topUrls = urls
        .map((u) => ({ key: u.key, destination: u.destination, clicks: clicks.get(u.key) ?? 0 }))
        .sort((a, b) => b.clicks - a.clicks);

    return {
        hostname,
        totalClicks: logs.length,
        // ユニークビジター: UA + country の組み合わせで近似
        uniqueVisitors: new Set(logs.map((l) => l.visitorId)).size,
        dailyStats: computeDailyStats(logs, 30),
        hourlyStats: computeHourlyStats(logs),
        referrerStats: computeDistribution(logs.map((l) => l.referrer || 'ダイレクト')),
        deviceStats: computeDistribution(logs.map((l) => l.device)),
        browserStats: computeDistribution(logs.map((l) => l.browser)),
        osStats: computeDistribution(logs.map((l) => l.os)),
        countryStats: computeDistribution(logs.map((l) => l.country || '不明')),
        topUrls,
    };
}
