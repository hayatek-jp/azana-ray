# AzanaRay
A Cloudflare Workers®–based URL shortener with access analytics.

## How to Deploy

1. Install Node.js

2. Install pnpm and dependencies

    ```
    $ npm install -g pnpm
    $ pnpm install
    ```

2. Create `wrangler.jsonc`  
    Copy `wrangler.jsonc.sample` to `wrangler.jsonc` and fill in the placeholder parts.

3. Configurate Workers KV
    ```
    pnpm wrangler kv namespace create azana-ray_session --binding SESSION
    pnpm wrangler kv namespace create azana-ray_urls --binding URLS
    pnpm wrangler kv namespace create azana-ray_url_meta --binding URL_META
    pnpm wrangler kv namespace create azana-ray_access_logs --binding ACCESS_LOGS
    ```

4. Deploy
    ```
    pnpm run deploy
    ```

5. Configurate Cloudflare Access™  
    You need to protect `/dashboard`, `/dashboard/*`, `/api`, and `/api/*`
