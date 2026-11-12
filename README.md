# apphub-mcp

Personal App Management MCP Server — Cloudflare Workers 上で動く、**App Store Connect 専用・読み取り専用**の Remote MCP サーバーです。

- Cloudflare Workers / TypeScript
- Cloudflare 公式 [`agents`](https://www.npmjs.com/package/agents) SDK（0.33）の `createMcpHandler` ＋ 公式 MCP SDK（`agents` が要求する版に固定: `@modelcontextprotocol/sdk` 1.32.2 / `@modelcontextprotocol/server` 2.4.0）
- **Streamable HTTP**（ステートレス）、エンドポイント `/mcp`
- App Store Connect API へ **ES256 JWT** で接続（WebCrypto で署名、最長 20 分・自動更新）
- Apple の API キーは **Cloudflare Secrets** から取得（GitHub には保存しない）
- MCP へのアクセスは **Bearer Token** で認証
- 複数アプリ対応（App ID でもバンドル ID でも指定可、許可リストで絞り込み可）
- 初期段階は **GET のみ**（書き込み系 API は実装していません）

## 提供ツール

| ツール | 内容 |
| --- | --- |
| `list_apps` | アプリ一覧（ID・名前・バンドル ID・SKU） |
| `get_app` | アプリ詳細＋最近の App Store バージョン |
| `list_app_store_versions` | バージョン一覧と審査・配信状態（プラットフォーム／バージョン番号で絞り込み可） |
| `list_builds` | ビルド一覧（新しい順、処理状態・TestFlight 状態付き） |
| `get_build` | ビルド 1 件の詳細と TestFlight 状態 |
| `get_testflight_info` | TestFlight ベータグループ（`includeTesters: true` でテスター一覧、メールを含む） |
| `list_subscriptions` | サブスクリプショングループとサブスクリプション（プロダクト ID・期間・状態） |
| `get_subscription_prices` | サブスクリプション価格（顧客価格・収益、地域指定可 例: `JPN`） |

`app` 引数には App Store Connect の App ID（数字）かバンドル ID（例: `com.example.app`）を指定できます。

## エンドポイント

| パス | 認証 | 用途 |
| --- | --- | --- |
| `GET /health` | 不要 | 稼働確認（設定値や秘密情報は返しません） |
| `/mcp` | `Authorization: Bearer <MCP_BEARER_TOKEN>` | MCP（Streamable HTTP） |

トークン未設定時は `/mcp` を 503 で拒否します（フェイルクローズ）。

## セットアップ

### 1. App Store Connect API キーを作る

1. [App Store Connect › ユーザとアクセス › 統合 › App Store Connect API](https://appstoreconnect.apple.com/access/integrations/api) を開く
2. 「チームキー」でキーを作成（読み取りだけなら **Developer** や **Sales** などの最小権限で十分。サブスクリプション価格の取得には App Manager 以上が必要な場合があります）
3. 以下を控える
   - **Issuer ID**
   - **Key ID**
   - **AuthKey_XXXXXXXXXX.p8**（ダウンロードは 1 回だけ。リポジトリ内に置かないこと）

### 2. インストール

```bash
npm install
npx wrangler login
```

### 3. Secrets を登録（Cloudflare 側に保存）

```bash
npx wrangler secret put ASC_ISSUER_ID
npx wrangler secret put ASC_KEY_ID
# .p8 ファイルの中身をそのまま渡す（改行込みで OK）
npx wrangler secret put ASC_PRIVATE_KEY < ~/Downloads/AuthKey_XXXXXXXXXX.p8
# MCP クライアント用のアクセストークン（長いランダム文字列）
openssl rand -base64 48 | tr -d '\n' | npx wrangler secret put MCP_BEARER_TOKEN
```

- `MCP_BEARER_TOKEN` はカンマ区切りで複数指定でき、ローテーション時に新旧を並行運用できます。
- 秘密鍵は `-----BEGIN PRIVATE KEY-----` 形式（PKCS#8）の .p8 をそのまま使います。`\n` でエスケープした 1 行形式も受け付けます。

### 4. （任意）対象アプリを限定する

`wrangler.jsonc` の `vars.ASC_ALLOWED_APP_IDS` に App ID をカンマ区切りで書くと、それ以外のアプリへのアクセスを拒否します。空なら API キーで見えるすべてのアプリが対象です。

```jsonc
"vars": { "ASC_ALLOWED_APP_IDS": "1234567890,9876543210" }
```

### 5. デプロイ

```bash
npm run deploy
```

`https://apphub-mcp.<your-subdomain>.workers.dev/mcp` が MCP エンドポイントになります。

### GitHub 連携（Workers Builds）でデプロイする場合

Cloudflare ダッシュボード › Workers & Pages › 作成 › **Workers**（Pages ではない）› GitHub リポジトリをインポート。

| 項目 | 値 |
| --- | --- |
| プロジェクト名 | `apphub-mcp`（`wrangler.jsonc` の `name` と一致させる） |
| 本番ブランチ | `main` |
| ビルドコマンド | 空欄（依存関係は自動インストール） |
| デプロイコマンド | `npx wrangler deploy` |
| ルートディレクトリ | `/` |

Secrets（`ASC_ISSUER_ID` / `ASC_KEY_ID` / `ASC_PRIVATE_KEY` / `MCP_BEARER_TOKEN`）は Worker の **設定 › 変数とシークレット** で「シークレット」として追加します（ビルド用変数ではなく Worker のランタイム変数）。

> `Could not detect a directory containing static files` と出る場合は、デプロイ対象ブランチに `wrangler.jsonc` が無いか、Pages プロジェクトとして作成されています。

## 動作確認

```bash
URL=https://apphub-mcp.<your-subdomain>.workers.dev
TOKEN=<MCP_BEARER_TOKEN>

curl $URL/health

curl -sS $URL/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

MCP Inspector でも確認できます: `npx @modelcontextprotocol/inspector` → Transport「Streamable HTTP」、URL に `/mcp`、ヘッダーに `Authorization: Bearer ...`。

## MCP クライアントへの接続

カスタムヘッダーを付けられるクライアントでは、URL `https://.../mcp` と `Authorization: Bearer <MCP_BEARER_TOKEN>` を設定します。

例（ヘッダー指定に対応したクライアント設定 / `mcp-remote` 経由）:

```json
{
  "mcpServers": {
    "apphub": {
      "command": "npx",
      "args": ["mcp-remote", "https://apphub-mcp.<your-subdomain>.workers.dev/mcp",
               "--header", "Authorization: Bearer ${APPHUB_TOKEN}"],
      "env": { "APPHUB_TOKEN": "<MCP_BEARER_TOKEN>" }
    }
  }
}
```

> 注: claude.ai の「カスタムコネクタ」のように OAuth 前提でヘッダーを設定できないクライアントでは、このままでは接続できません。その場合は今後 `@cloudflare/workers-oauth-provider` による OAuth 対応を追加する想定です。

## ローカル開発

```bash
cp .dev.vars.example .dev.vars   # 実際の値を入れる（.dev.vars は git 管理外）
npm run dev                      # http://localhost:8787/mcp
npm run check                    # 型チェック + テスト
npm run build                    # wrangler のドライラン（バンドル確認、デプロイしない）
```

## セキュリティ

- 秘密情報（Issuer ID・Key ID・.p8・Bearer Token）は Cloudflare Secrets にのみ保存します。`.gitignore` で `.dev.vars`・`*.p8`・`*.pem`・`.env` を除外済みです。
- App Store Connect クライアントは GET のみ実装し、`api.appstoreconnect.apple.com` 以外へのリクエスト（ページングの `next` リンクを含む）を拒否します。
- Bearer Token は SHA-256 ダイジェスト同士の定数時間比較で検証します。
- Apple から 401 が返った場合は JWT を作り直して 1 回だけ再試行します。

## 構成

```
src/
  index.ts       Worker エントリ（agents/mcp の createMcpHandler）
  worker.ts      ルーティングと Bearer 認証
  server.ts      McpServer とツール定義（zod スキーマ）
  tools.ts       ツール本体（App Store Connect 呼び出しと整形）
  asc-client.ts  読み取り専用 App Store Connect API クライアント
  jwt.ts         ES256 JWT 生成とキャッシュ
  auth.ts        Bearer Token 検証
  env.ts         環境変数の型
test/            node:test によるユニットテスト
```

## 今後の拡張候補

- OAuth 対応（claude.ai カスタムコネクタ等向け）
- カスタマーレビュー、売上・分析レポート、アプリ内課金（非サブスク）
- 書き込み系操作（メタデータ更新、TestFlight 配布など）は確認フロー付きで別途検討
