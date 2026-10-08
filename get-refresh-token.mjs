// One-off: get a Google refresh token for the Search Console API.
//
// Run locally (Node 18+):
//   node get-refresh-token.mjs
//
// Or skip the prompts by passing the values as environment variables:
//   PowerShell:  $env:GOOGLE_CLIENT_ID="..."; $env:GOOGLE_CLIENT_SECRET="..."; node get-refresh-token.mjs
//   bash/zsh:    GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... node get-refresh-token.mjs
//
// Needs a Google OAuth client of type "Web application" with
// http://localhost:3000/callback added as an authorised redirect URI.
//
// On success it writes refresh-token.txt next to this file and prints the
// exact `npx supabase secrets set` command to run. refresh-token.txt is in
// .gitignore. Delete it once the secret is set.

import http from "node:http";
import fs from "node:fs";
import { exec } from "node:child_process";
import readline from "node:readline";

const ask = (q) =>
  new Promise((res) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(q, (a) => { rl.close(); res(a.trim()); });
  });

const clientId = (process.env.GOOGLE_CLIENT_ID || (await ask("Google client ID: "))).trim();
const clientSecret = (process.env.GOOGLE_CLIENT_SECRET || (await ask("Google client secret: "))).trim();

if (!clientId.endsWith(".apps.googleusercontent.com")) {
  console.error("\nThat does not look like a Google client ID (it should end in .apps.googleusercontent.com). Run the script again.");
  process.exit(1);
}
if (!clientSecret.startsWith("GOCSPX-")) {
  console.error("\nThat does not look like a Google client secret (they start with GOCSPX-). Run the script again.");
  process.exit(1);
}

const redirectUri = "http://localhost:3000/callback";
const scope = "https://www.googleapis.com/auth/webmasters.readonly https://www.googleapis.com/auth/webmasters";

const authUrl =
  "https://accounts.google.com/o/oauth2/v2/auth?" +
  new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    access_type: "offline",
    prompt: "consent", // forces a refresh token to be issued
    scope,
  });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost:3000");
  if (url.pathname !== "/callback") { res.writeHead(404); res.end(); return; }
  const code = url.searchParams.get("code");
  if (!code) { res.writeHead(400); res.end("Missing code"); return; }

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  const json = await tokenRes.json();

  if (!json.refresh_token) {
    res.end("No refresh token returned. Remove the app under myaccount.google.com/permissions and run again.");
    console.error("\nGoogle did not return a refresh token:\n", json);
  } else {
    res.end("Done. You can close this tab and go back to the terminal.");
    fs.writeFileSync("refresh-token.txt", json.refresh_token, { mode: 0o600 });
    console.log("\nRefresh token saved to refresh-token.txt (" + json.refresh_token.length + " characters).\n");
    console.log("Now run this from the same folder (it reads the token from the file, nothing to copy):\n");
    if (process.platform === "win32") {
      console.log('  npx supabase secrets set GOOGLE_REFRESH_TOKEN="$(Get-Content refresh-token.txt -Raw)"\n');
    } else {
      console.log('  npx supabase secrets set GOOGLE_REFRESH_TOKEN="$(cat refresh-token.txt)"\n');
    }
    console.log("Then delete refresh-token.txt.\n");
  }
  server.close();
});

server.listen(3000, () => {
  console.log("\nOpen this URL and sign in with the Google account that owns the Search Console properties:\n\n" + authUrl + "\n");
  const opener = process.platform === "win32" ? "start \"\"" : process.platform === "darwin" ? "open" : "xdg-open";
  exec(`${opener} "${authUrl}"`);
});
