// SPDX-FileCopyrightText: 2026 KATO Hayate <dev@hayatek.jp>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * URL_META KV に保存するメタデータ
 */
export interface UrlMeta {
    /** ユーザーが設定できるコメント */
    comment: string;
    /** 作成日時 (ISO 8601) */
    createdAt: string;
}

/**
 * 短縮URLエントリ (API レスポンス用)
 */
export interface ShortenedUrl {
    /** 短縮キー */
    key: string;
    /** リダイレクト先URL */
    destination: string;
    /** ユーザーが設定できるコメント */
    comment: string;
    /** 作成日時 */
    createdAt: string;
    /** 総アクセス数 */
    totalClicks: number;
}

/**
 * ホスト名ごとのグループ
 */
export interface HostGroup {
    /** ホスト名 (e.g. "example.com") */
    hostname: string;
    /** グループに属するURL数 */
    urlCount: number;
    /** グループ全体のアクセス数 */
    totalClicks: number;
}

/**
 * ACCESS_LOGS KV に保存するアクセスログ1件
 */
export interface AccessLog {
    /** 短縮キー */
    key: string;
    /** アクセス日時 (ISO 8601) */
    timestamp: string;
    /** リファラー */
    referrer: string;
    /** User-Agent */
    userAgent: string;
    /** 国 (cf.country) */
    country: string;
    /** 都市 (cf.city) */
    city: string;
    /** 大陸 (cf.continent) */
    continent: string;
    /** タイムゾーン (cf.timezone) */
    timezone: string;
    /** ASN (cf.asn) */
    asn: number;
    /** デバイスタイプ (解析結果) */
    device: 'desktop' | 'mobile' | 'tablet';
    /** ブラウザ名 (解析結果) */
    browser: string;
    /** OS名 (解析結果) */
    os: string;
}

/**
 * 日別アクセス統計
 */
export interface DailyStats {
    date: string;
    clicks: number;
}

/**
 * リファラー統計
 */
export interface ReferrerStats {
    referrer: string;
    count: number;
    percentage: number;
}

/**
 * デバイス統計
 */
export interface DeviceStats {
    device: string;
    count: number;
    percentage: number;
}

/**
 * ブラウザ統計
 */
export interface BrowserStats {
    browser: string;
    count: number;
    percentage: number;
}

/**
 * OS統計
 */
export interface OsStats {
    os: string;
    count: number;
    percentage: number;
}

/**
 * 国別統計
 */
export interface CountryStats {
    country: string;
    count: number;
    percentage: number;
}

/**
 * グループ別アクセス解析データ
 */
export interface GroupAnalytics {
    hostname: string;
    totalClicks: number;
    uniqueVisitors: number;
    dailyStats: DailyStats[];
    referrerStats: ReferrerStats[];
    deviceStats: DeviceStats[];
    browserStats: BrowserStats[];
    osStats: OsStats[];
    countryStats: CountryStats[];
    topUrls: { key: string; destination: string; clicks: number }[];
}
