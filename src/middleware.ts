// SPDX-FileCopyrightText: 2026 KATO Hayate <dev@hayatek.jp>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Cloudflare Access の JWT (CF_Authorization) を検証するミドルウェア。
 * /api および /dashboard 配下のリクエストに対して認証を要求する。
 *
 * 検証の流れ:
 * 1. Cookie `CF_Authorization` から JWT を取得
 * 2. Cloudflare Access の JWKS エンドポイントから公開鍵を取得
 * 3. JWT の署名・有効期限・audience (AUD) を検証
 */

import { defineMiddleware } from 'astro:middleware';
import { env } from 'cloudflare:workers';

/** 保護対象のパスプレフィックス */
const PROTECTED_PREFIXES = ['/api', '/dashboard'];

/** JWKS のキャッシュ (Worker のライフタイム内で有効) */
let cachedJwks: JsonWebKeySet | null = null;

interface JsonWebKeySet {
    keys: JsonWebKey[];
}

interface JwtHeader {
    alg: string;
    kid: string;
    typ?: string;
}

interface JwtPayload {
    iss: string;
    sub: string;
    aud: string[];
    exp: number;
    iat: number;
    email?: string;
    [key: string]: unknown;
}

export const onRequest = defineMiddleware(async ({ request, url }, next) => {
    // 保護対象外のパスはスルー
    const isProtected = PROTECTED_PREFIXES.some((prefix) => url.pathname.startsWith(prefix));
    if (!isProtected) {
        return next();
    }

    const teamDomain = env.CF_ACCESS_TEAM_DOMAIN; // e.g. "myteam.cloudflareaccess.com"
    const policyAud = env.CF_ACCESS_AUD;           // Application Audience (AUD) tag

    // 環境変数未設定時はスキップ (ローカル開発用)
    if (!teamDomain || !policyAud) {
        return next();
    }

    // Cookie から JWT を取得
    const cookieHeader = request.headers.get('cookie') ?? '';
    const token = parseCookie(cookieHeader, 'CF_Authorization');

    if (!token) {
        return new Response('401 Unauthorized', { status: 401 });
    }

    try {
        await verifyJwt(token, teamDomain, policyAud);
    } catch {
        return new Response('403 Forbidden', { status: 403 });
    }

    return next();
});


/**
 * Cookie ヘッダーから指定キーの値を取得
 */
function parseCookie(cookieHeader: string, name: string): string | null {
    const match = cookieHeader
        .split(';')
        .map((c) => c.trim())
        .find((c) => c.startsWith(`${name}=`));
    return match ? match.slice(name.length + 1) : null;
}

/**
 * JWT を検証する
 */
async function verifyJwt(
    token: string,
    teamDomain: string,
    expectedAud: string,
): Promise<JwtPayload> {
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error('Invalid JWT format');

    const header: JwtHeader = JSON.parse(base64UrlDecode(parts[0]));
    const payload: JwtPayload = JSON.parse(base64UrlDecode(parts[1]));

    // 有効期限チェック
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp < now) {
        throw new Error('Token expired');
    }

    // Audience チェック
    const audList = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!audList.includes(expectedAud)) {
        throw new Error('Invalid audience');
    }

    // Issuer チェック
    const expectedIssuer = `https://${teamDomain}`;
    if (payload.iss !== expectedIssuer) {
        throw new Error('Invalid issuer');
    }

    // JWKS から公開鍵を取得して署名を検証
    const jwks = await fetchJwks(teamDomain);
    const jwk = jwks.keys.find((k) => k.kid === header.kid);
    if (!jwk) {
        // キーが見つからない場合はキャッシュを破棄してリトライ
        cachedJwks = null;
        const refreshedJwks = await fetchJwks(teamDomain);
        const retryJwk = refreshedJwks.keys.find((k) => k.kid === header.kid);
        if (!retryJwk) throw new Error('Signing key not found');
        await verifySignature(token, parts, retryJwk);
    } else {
        await verifySignature(token, parts, jwk);
    }

    return payload;
}

/**
 * JWKS エンドポイントから公開鍵セットを取得 (キャッシュ付き)
 */
async function fetchJwks(teamDomain: string): Promise<JsonWebKeySet> {
    if (cachedJwks) return cachedJwks;

    const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
    if (!res.ok) throw new Error(`Failed to fetch JWKS: ${res.status}`);

    cachedJwks = (await res.json()) as JsonWebKeySet;
    return cachedJwks;
}

/**
 * RS256 署名を検証
 */
async function verifySignature(
    _token: string,
    parts: string[],
    jwk: JsonWebKey,
): Promise<void> {
    const key = await crypto.subtle.importKey(
        'jwk',
        jwk,
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['verify'],
    );

    const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    const signature = base64UrlDecodeToBuffer(parts[2]);

    const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, data);
    if (!valid) throw new Error('Invalid signature');
}

/**
 * Base64URL デコード (文字列)
 */
function base64UrlDecode(str: string): string {
    const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    return atob(padded);
}

/**
 * Base64URL デコード (ArrayBuffer)
 */
function base64UrlDecodeToBuffer(str: string): ArrayBuffer {
    const binary = base64UrlDecode(str);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
}
