// SPDX-FileCopyrightText: 2026 KATO Hayate <dev@hayatek.jp>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * User-Agent 文字列からブラウザ・OS・デバイスタイプを解析するユーティリティ。
 * 外部ライブラリを使わず、軽量な正規表現マッチングで実装。
 */

export function parseBrowser(ua: string): string {
    if (/Edg\//i.test(ua)) return 'Edge';
    if (/OPR\//i.test(ua) || /Opera/i.test(ua)) return 'Opera';
    if (/SamsungBrowser/i.test(ua)) return 'Samsung Browser';
    if (/UCBrowser/i.test(ua)) return 'UC Browser';
    if (/Firefox\//i.test(ua)) return 'Firefox';
    if (/Chrome\//i.test(ua) && !/Chromium/i.test(ua)) return 'Chrome';
    if (/Safari\//i.test(ua) && !/Chrome/i.test(ua)) return 'Safari';
    if (/MSIE|Trident/i.test(ua)) return 'IE';
    return 'Other';
}

export function parseOs(ua: string): string {
    if (/Windows/i.test(ua)) return 'Windows';
    if (/iPhone|iPad|iPod/i.test(ua)) return 'iOS';
    if (/Mac OS X|macOS/i.test(ua)) return 'macOS';
    if (/Android/i.test(ua)) return 'Android';
    if (/CrOS/i.test(ua)) return 'ChromeOS';
    if (/Linux/i.test(ua)) return 'Linux';
    return 'Other';
}

export function parseDevice(ua: string): 'desktop' | 'mobile' | 'tablet' {
    if (/iPad|tablet|Kindle|Silk/i.test(ua)) return 'tablet';
    if (/Mobile|iPhone|iPod|Android.*Mobile|webOS|BlackBerry|Opera Mini|IEMobile/i.test(ua)) return 'mobile';
    return 'desktop';
}

export function parseReferrerDomain(referrer: string): string {
    if (!referrer) return 'ダイレクト';
    try {
        const url = new URL(referrer);
        return url.hostname;
    } catch {
        return 'ダイレクト';
    }
}
