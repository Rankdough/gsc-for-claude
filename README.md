# gsc-mcp: a Google Search Console connector for Claude

Ask Claude about your Search Console data in plain English. Top queries for a site over 28 days, which pages dropped against the previous period, whether a URL is indexed, which of 20 URLs Google has skipped.

It runs as a Supabase Edge Function on your own account, with your own Google login. Your data stays with you. Free on the Supabase free tier.

Built by [Roman Sadowski](https://www.rankdough.com) at Rank Dough because there was no Search Console connector for the Claude browser app, and Claude Code lives in a terminal with no shared history. The data needs to sit where the knowledge is.

## What you get

Eight tools. Claude picks the right one from your question, you never name them.

- `list_sites`: every property your Google account can see, with permission level
- `search_analytics`: clicks, impressions, CTR, position by query, page, country, device, date, search appearance; filters and search type
- `compare_periods`: what grew and what dropped between two date ranges
- `inspect_url`: index status, canonical, crawl date, mobile usability for one URL
- `indexation_summary`: index status for a batch of up to 20 URLs
- `list_sitemaps`, `submit_sitemap`, `delete_sitemap`

Performance data lags about three days. That's Google, not the connector.

## What you need

- A Google account that has access to the Search Console properties
- A free [Supabase](https://supabase.com) account
- Node 18 or newer on your computer (check with `node --version`)
- About 30 minutes the first time

No Docker, no server, no credit card.

## Setup

Five steps. Do them in order.

### 1. Google Cloud: enable the API and create an OAuth client

1. Go to https://console.cloud.google.com and pick or create a project.
2. APIs & Services > Library > search "Google Search Console API" > Enable.
3. APIs & Services > Credentials > Create credentials > OAuth client ID.
4. Application type: **Web application**. Not Desktop. Desktop clients won't work with this script.
5. Under "Authorised redirect URIs" click Add URI and paste exactly: `http://localhost:3000/callback` (http, not https, no trailing slash).
6. Create. Copy the **Client ID** (ends in `.apps.googleusercontent.com`).
7. Click **Add secret** (or copy the secret shown). Copy it now, it starts with `GOCSPX-`. Google only shows it once.
8. Left menu > **Audience** (older consoles call it "OAuth consent screen"). If the app is in **Testing**, click **Publish app**. Testing-mode refresh tokens die after seven days and you'll be back here. Publishing needs no verification for your own use; Google just shows a one-time "unverified app" warning when you sign in.

### 2. Get a refresh token

Download this repo (green Code button > Download ZIP), unzip it, open a terminal in the folder that contains `get-refresh-token.mjs`.

Windows PowerShell:

```powershell
cd "$HOME\Downloads\gsc-for-claude-main"
node get-refresh-token.mjs
```

Mac or Linux:

```bash
cd ~/Downloads/gsc-for-claude-main
node get-refresh-token.mjs
```

It asks for the Client ID, then the secret. Paste each one and press Enter. A browser tab opens. Sign in with the Google account that owns the Search Console properties, click Advanced > Go to (your app name) if Google warns about an unverified app, and Allow.

The script saves the token to `refresh-token.txt` and prints the exact command for step 4. You never copy the token by hand.

If pasting at the prompts misbehaves, pass the values in instead:

```powershell
$env:GOOGLE_CLIENT_ID="paste-client-id"; $env:GOOGLE_CLIENT_SECRET="paste-secret"; node get-refresh-token.mjs
```

### 3. Supabase: log in and link a project

You don't need to install the Supabase CLI. `npx` fetches it on demand. From the same folder:

```powershell
npx supabase login
npx supabase projects list
npx supabase link --project-ref YOUR_PROJECT_REF
```

`projects list` shows your project refs (20 lowercase letters). If you have no project yet, create one at https://supabase.com/dashboard, free tier is fine. If `link` asks for a database password, press Enter to skip it.

If `link` says "project is paused", open the project in the Supabase dashboard and click Restore. Free-tier projects pause after a week of inactivity.

### 4. Set the secrets and deploy

Make up a long random password for the connector. This is what Claude will use to talk to your function. Example generator: https://www.random.org/strings/ (set length 40, or run `openssl rand -hex 24`).

```powershell
npx supabase secrets set GOOGLE_CLIENT_ID="paste-client-id" GOOGLE_CLIENT_SECRET="paste-secret" MCP_SECRET="your-long-random-password"
npx supabase secrets set GOOGLE_REFRESH_TOKEN="$(Get-Content refresh-token.txt -Raw)"
npx supabase functions deploy gsc-mcp --no-verify-jwt
```

On Mac or Linux the second line is `GOOGLE_REFRESH_TOKEN="$(cat refresh-token.txt)"`.

`--no-verify-jwt` is required. Without it Supabase rejects Claude's requests because Claude doesn't send a Supabase key. Access is protected by `MCP_SECRET` instead.

A "Docker is not running" warning is fine. Deploy doesn't need Docker.

Delete `refresh-token.txt` when done.

### 5. Add the connector to Claude

1. claude.ai > Settings > Connectors > Add custom connector.
2. Name: `GSC`
3. URL:

```
https://YOUR_PROJECT_REF.supabase.co/functions/v1/gsc-mcp?key=YOUR_MCP_SECRET
```

4. Leave the OAuth fields blank. Add.
5. New chat, make sure GSC is switched on in the tools menu, ask "List my Search Console sites."

## Check it works without Claude

```bash
curl -X POST "https://YOUR_PROJECT_REF.supabase.co/functions/v1/gsc-mcp?key=YOUR_MCP_SECRET" \
  -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_sites","arguments":{}}}'
```

You should get your property list back as JSON.

## When something goes wrong

- **401 from the function**: the `key` in the URL doesn't match `MCP_SECRET`. Check for a trailing space or a missing character.
- **`invalid_grant` from Google**: the refresh token is wrong, expired or revoked. Common causes: the token was copied with characters missing (always use the `Get-Content` or `cat` command from step 4), the OAuth app is still in Testing mode and seven days passed, or you removed the app under myaccount.google.com/permissions. Fix: run step 2 again and reset only `GOOGLE_REFRESH_TOKEN`.
- **`invalid_client` or "OAuth client was not found" during sign-in**: the Client ID was pasted wrong at the prompt. Run the script again, or pass the values as environment variables (step 2).
- **"Missing required parameter: client_id"**: the script got an empty Client ID. Same fix.
- **"localhost refused to connect" after Google sign-in**: the script wasn't running when Google sent you back. Start the script first, then sign in.
- **No refresh token returned**: Google only issues one on the first consent. Go to https://myaccount.google.com/permissions, remove the app, run the script again.
- **"project is paused"**: Restore it in the Supabase dashboard.
- **`supabase: command not recognised`**: use `npx supabase ...` as written above. `npm install -g supabase` is blocked by Supabase.
- **PowerShell error about `&` or `<`**: you pasted a URL or a placeholder into the prompt. Only paste the commands shown.

## Security notes

- Anyone with your connector URL can read all your Search Console properties and submit or delete sitemaps. Treat the URL like a password.
- The function also accepts the key in an `x-mcp-key` header instead of the URL, if your client supports custom headers.
- For read-only, edit `get-refresh-token.mjs` and remove `https://www.googleapis.com/auth/webmasters` from `scope`, leaving `webmasters.readonly`. The two write tools will then fail with a permission error.
- To rotate: new client secret in Google Cloud, run step 2 again, reset the three Google secrets, and pick a new `MCP_SECRET` and update the Claude connector URL.
- Nothing in this repo phones home. Read `supabase/functions/gsc-mcp/index.ts`, it's one file.

## Google API quotas

Google's limits are listed at https://developers.google.com/webmaster-tools/limits. Normal Claude use won't get near them. Heavy batch inspection of URLs is the one thing that can.

## Licence

MIT. Use it, change it, ship it. A link back to [rankdough.com](https://www.rankdough.com) is appreciated, not required.
