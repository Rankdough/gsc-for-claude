// gsc-mcp: Google Search Console MCP connector for Claude.
// Supabase Edge Function (Deno). Streamable HTTP MCP, stateless JSON responses.
//
// Tools:
//   list_sites, search_analytics, inspect_url, list_sitemaps,
//   submit_sitemap, delete_sitemap, indexation_summary, compare_periods
//
// Required secrets (supabase secrets set ...):
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN, MCP_SECRET
//
// Deploy:  supabase functions deploy gsc-mcp --no-verify-jwt
// Claude:  https://<project-ref>.supabase.co/functions/v1/gsc-mcp?key=<MCP_SECRET>

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "gsc-mcp", version: "1.0.0" };

const env = (k: string): string => {
  const v = Deno.env.get(k);
  if (!v) throw new Error(`Missing env var ${k}`);
  return v;
};

// ---------- Google auth ----------

let cachedToken: { value: string; expiresAt: number } | null = null;

async function accessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) {
    return cachedToken.value;
  }
  const body = new URLSearchParams({
    client_id: env("GOOGLE_CLIENT_ID"),
    client_secret: env("GOOGLE_CLIENT_SECRET"),
    refresh_token: env("GOOGLE_REFRESH_TOKEN"),
    grant_type: "refresh_token",
  });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    throw new Error(`Google token refresh failed (${res.status}): ${await res.text()}`);
  }
  const json = await res.json() as { access_token: string; expires_in: number };
  cachedToken = {
    value: json.access_token,
    expiresAt: Date.now() + json.expires_in * 1000,
  };
  return cachedToken.value;
}

async function gapi(
  method: "GET" | "POST" | "PUT" | "DELETE",
  url: string,
  body?: unknown,
): Promise<unknown> {
  const token = await accessToken();
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Google API ${method} ${url} failed (${res.status}): ${text}`);
  }
  return text ? JSON.parse(text) : {};
}

const WMT = "https://www.googleapis.com/webmasters/v3";
const SC = "https://searchconsole.googleapis.com/v1";
const enc = encodeURIComponent;

// ---------- Tool implementations ----------

type Args = Record<string, unknown>;

interface SAQuery {
  startDate: string;
  endDate: string;
  dimensions?: string[];
  dimensionFilterGroups?: unknown[];
  rowLimit?: number;
  startRow?: number;
  type?: string;
  dataState?: string;
  aggregationType?: string;
}

async function searchAnalytics(siteUrl: string, q: SAQuery): Promise<unknown> {
  return await gapi("POST", `${WMT}/sites/${enc(siteUrl)}/searchAnalytics/query`, q);
}

function requireStr(a: Args, k: string): string {
  const v = a[k];
  if (typeof v !== "string" || !v) throw new Error(`Argument "${k}" is required`);
  return v;
}

function buildFilters(a: Args): unknown[] | undefined {
  const filters = a.filters as
    | { dimension: string; operator?: string; expression: string }[]
    | undefined;
  if (!filters || filters.length === 0) return undefined;
  return [{
    filters: filters.map((f) => ({
      dimension: f.dimension,
      operator: f.operator ?? "equals",
      expression: f.expression,
    })),
  }];
}

const tools: Record<string, { def: unknown; run: (a: Args) => Promise<unknown> }> = {
  list_sites: {
    def: {
      name: "list_sites",
      description:
        "List all Search Console properties the connected Google account can access, with permission level. Call this first to get exact siteUrl values (e.g. 'sc-domain:example.com' or 'https://www.example.com/').",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    run: async () => await gapi("GET", `${WMT}/sites`),
  },

  search_analytics: {
    def: {
      name: "search_analytics",
      description:
        "Run a Search Console performance query (clicks, impressions, CTR, position). Group by any of: query, page, country, device, date, searchAppearance. Supports filters, row limits and search type (web, image, video, news, discover, googleNews). Data is final after ~3 days; use dataState 'all' for fresh data.",
      inputSchema: {
        type: "object",
        properties: {
          siteUrl: { type: "string", description: "Exact property URL from list_sites" },
          startDate: { type: "string", description: "YYYY-MM-DD" },
          endDate: { type: "string", description: "YYYY-MM-DD" },
          dimensions: {
            type: "array",
            items: { type: "string", enum: ["query", "page", "country", "device", "date", "searchAppearance"] },
            description: "Dimensions to group by. Omit for totals only.",
          },
          filters: {
            type: "array",
            description: "Optional dimension filters, ANDed together.",
            items: {
              type: "object",
              properties: {
                dimension: { type: "string", enum: ["query", "page", "country", "device", "searchAppearance"] },
                operator: { type: "string", enum: ["equals", "notEquals", "contains", "notContains", "includingRegex", "excludingRegex"] },
                expression: { type: "string" },
              },
              required: ["dimension", "expression"],
            },
          },
          rowLimit: { type: "integer", minimum: 1, maximum: 25000, default: 100 },
          startRow: { type: "integer", minimum: 0, default: 0 },
          type: { type: "string", enum: ["web", "image", "video", "news", "discover", "googleNews"], default: "web" },
          dataState: { type: "string", enum: ["final", "all"], default: "final" },
          aggregationType: { type: "string", enum: ["auto", "byPage", "byProperty"] },
        },
        required: ["siteUrl", "startDate", "endDate"],
        additionalProperties: false,
      },
    },
    run: async (a) => {
      const q: SAQuery = {
        startDate: requireStr(a, "startDate"),
        endDate: requireStr(a, "endDate"),
        rowLimit: typeof a.rowLimit === "number" ? a.rowLimit : 100,
        startRow: typeof a.startRow === "number" ? a.startRow : 0,
        type: typeof a.type === "string" ? a.type : "web",
        dataState: typeof a.dataState === "string" ? a.dataState : "final",
      };
      if (Array.isArray(a.dimensions) && a.dimensions.length) q.dimensions = a.dimensions as string[];
      const f = buildFilters(a);
      if (f) q.dimensionFilterGroups = f;
      if (typeof a.aggregationType === "string") q.aggregationType = a.aggregationType;
      return await searchAnalytics(requireStr(a, "siteUrl"), q);
    },
  },

  compare_periods: {
    def: {
      name: "compare_periods",
      description:
        "Compare two date ranges for a property, by an optional dimension (query or page). Returns rows with clicks, impressions, CTR and position for both periods plus absolute and percentage change, sorted by click change. Good for 'what dropped / what grew' questions.",
      inputSchema: {
        type: "object",
        properties: {
          siteUrl: { type: "string" },
          currentStart: { type: "string", description: "YYYY-MM-DD" },
          currentEnd: { type: "string", description: "YYYY-MM-DD" },
          previousStart: { type: "string", description: "YYYY-MM-DD" },
          previousEnd: { type: "string", description: "YYYY-MM-DD" },
          dimension: { type: "string", enum: ["query", "page", "country", "device"], description: "Omit for totals only" },
          rowLimit: { type: "integer", minimum: 1, maximum: 5000, default: 500 },
          type: { type: "string", enum: ["web", "image", "video", "news", "discover", "googleNews"], default: "web" },
        },
        required: ["siteUrl", "currentStart", "currentEnd", "previousStart", "previousEnd"],
        additionalProperties: false,
      },
    },
    run: async (a) => {
      const siteUrl = requireStr(a, "siteUrl");
      const dim = typeof a.dimension === "string" ? a.dimension : undefined;
      const base: Partial<SAQuery> = {
        rowLimit: typeof a.rowLimit === "number" ? a.rowLimit : 500,
        type: typeof a.type === "string" ? a.type : "web",
        dataState: "final",
        ...(dim ? { dimensions: [dim] } : {}),
      };
      type Row = { keys?: string[]; clicks: number; impressions: number; ctr: number; position: number };
      const [cur, prev] = await Promise.all([
        searchAnalytics(siteUrl, { ...base, startDate: requireStr(a, "currentStart"), endDate: requireStr(a, "currentEnd") } as SAQuery),
        searchAnalytics(siteUrl, { ...base, startDate: requireStr(a, "previousStart"), endDate: requireStr(a, "previousEnd") } as SAQuery),
      ]) as [{ rows?: Row[] }, { rows?: Row[] }];

      const keyOf = (r: Row) => (r.keys ?? ["total"]).join("|");
      const map = new Map<string, { current?: Row; previous?: Row }>();
      for (const r of cur.rows ?? []) map.set(keyOf(r), { current: r });
      for (const r of prev.rows ?? []) map.set(keyOf(r), { ...(map.get(keyOf(r)) ?? {}), previous: r });

      const pct = (c: number, p: number) => (p === 0 ? (c === 0 ? 0 : null) : Math.round(((c - p) / p) * 1000) / 10);
      const rows = [...map.entries()].map(([key, v]) => {
        const c = v.current ?? { clicks: 0, impressions: 0, ctr: 0, position: 0 };
        const p = v.previous ?? { clicks: 0, impressions: 0, ctr: 0, position: 0 };
        return {
          key,
          current: { clicks: c.clicks, impressions: c.impressions, ctr: c.ctr, position: c.position },
          previous: { clicks: p.clicks, impressions: p.impressions, ctr: p.ctr, position: p.position },
          change: {
            clicks: c.clicks - p.clicks,
            clicksPct: pct(c.clicks, p.clicks),
            impressions: c.impressions - p.impressions,
            impressionsPct: pct(c.impressions, p.impressions),
            position: v.current && v.previous ? Math.round((c.position - p.position) * 10) / 10 : null,
          },
        };
      }).sort((x, y) => Math.abs(y.change.clicks) - Math.abs(x.change.clicks));

      return { siteUrl, dimension: dim ?? null, rowCount: rows.length, rows };
    },
  },

  inspect_url: {
    def: {
      name: "inspect_url",
      description:
        "Google URL Inspection: index status (verdict, coverage state, last crawl, canonical, robots/indexing state), mobile usability, rich results and AMP for one URL. Quota is roughly 2,000 inspections per property per day.",
      inputSchema: {
        type: "object",
        properties: {
          siteUrl: { type: "string", description: "Property the URL belongs to, from list_sites" },
          inspectionUrl: { type: "string", description: "Full URL to inspect" },
          languageCode: { type: "string", default: "en-GB" },
        },
        required: ["siteUrl", "inspectionUrl"],
        additionalProperties: false,
      },
    },
    run: async (a) =>
      await gapi("POST", `${SC}/urlInspection/index:inspect`, {
        siteUrl: requireStr(a, "siteUrl"),
        inspectionUrl: requireStr(a, "inspectionUrl"),
        languageCode: typeof a.languageCode === "string" ? a.languageCode : "en-GB",
      }),
  },

  indexation_summary: {
    def: {
      name: "indexation_summary",
      description:
        "Inspect a batch of URLs (max 20 per call) and summarise indexation: counts by verdict and coverage state, plus a per-URL list of anything not indexed with the reason. Uses URL Inspection quota.",
      inputSchema: {
        type: "object",
        properties: {
          siteUrl: { type: "string" },
          urls: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 20 },
        },
        required: ["siteUrl", "urls"],
        additionalProperties: false,
      },
    },
    run: async (a) => {
      const siteUrl = requireStr(a, "siteUrl");
      const urls = a.urls;
      if (!Array.isArray(urls) || urls.length === 0 || urls.length > 20) {
        throw new Error("urls must contain 1 to 20 URLs");
      }
      type Insp = {
        inspectionResult?: {
          indexStatusResult?: { verdict?: string; coverageState?: string; lastCrawlTime?: string; googleCanonical?: string; userCanonical?: string; robotsTxtState?: string; indexingState?: string; pageFetchState?: string };
        };
      };
      const results = await Promise.all((urls as string[]).map(async (u) => {
        try {
          const r = await gapi("POST", `${SC}/urlInspection/index:inspect`, { siteUrl, inspectionUrl: u, languageCode: "en-GB" }) as Insp;
          const s = r.inspectionResult?.indexStatusResult ?? {};
          return { url: u, verdict: s.verdict ?? "UNKNOWN", coverageState: s.coverageState ?? "unknown", lastCrawlTime: s.lastCrawlTime ?? null, googleCanonical: s.googleCanonical ?? null, userCanonical: s.userCanonical ?? null, robotsTxtState: s.robotsTxtState ?? null, indexingState: s.indexingState ?? null, pageFetchState: s.pageFetchState ?? null, error: null };
        } catch (e) {
          return { url: u, verdict: "ERROR", coverageState: null, lastCrawlTime: null, googleCanonical: null, userCanonical: null, robotsTxtState: null, indexingState: null, pageFetchState: null, error: (e as Error).message };
        }
      }));
      const count = (f: (r: typeof results[number]) => string | null) =>
        results.reduce<Record<string, number>>((acc, r) => { const k = f(r) ?? "null"; acc[k] = (acc[k] ?? 0) + 1; return acc; }, {});
      return {
        siteUrl,
        total: results.length,
        byVerdict: count((r) => r.verdict),
        byCoverageState: count((r) => r.coverageState),
        notIndexed: results.filter((r) => r.verdict !== "PASS"),
        all: results,
      };
    },
  },

  list_sitemaps: {
    def: {
      name: "list_sitemaps",
      description: "List sitemaps submitted for a property, with last submitted/downloaded time, errors, warnings and URL counts.",
      inputSchema: {
        type: "object",
        properties: { siteUrl: { type: "string" } },
        required: ["siteUrl"],
        additionalProperties: false,
      },
    },
    run: async (a) => await gapi("GET", `${WMT}/sites/${enc(requireStr(a, "siteUrl"))}/sitemaps`),
  },

  submit_sitemap: {
    def: {
      name: "submit_sitemap",
      description: "Submit (or resubmit) a sitemap URL for a property.",
      inputSchema: {
        type: "object",
        properties: { siteUrl: { type: "string" }, feedpath: { type: "string", description: "Full sitemap URL" } },
        required: ["siteUrl", "feedpath"],
        additionalProperties: false,
      },
    },
    run: async (a) => {
      await gapi("PUT", `${WMT}/sites/${enc(requireStr(a, "siteUrl"))}/sitemaps/${enc(requireStr(a, "feedpath"))}`);
      return { ok: true, submitted: a.feedpath };
    },
  },

  delete_sitemap: {
    def: {
      name: "delete_sitemap",
      description: "Remove a sitemap from a property in Search Console. Does not delete the file on the site.",
      inputSchema: {
        type: "object",
        properties: { siteUrl: { type: "string" }, feedpath: { type: "string" } },
        required: ["siteUrl", "feedpath"],
        additionalProperties: false,
      },
    },
    run: async (a) => {
      await gapi("DELETE", `${WMT}/sites/${enc(requireStr(a, "siteUrl"))}/sitemaps/${enc(requireStr(a, "feedpath"))}`);
      return { ok: true, deleted: a.feedpath };
    },
  },
};

// ---------- JSON-RPC / MCP ----------

type RpcReq = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: Record<string, unknown> };

const rpcResult = (id: RpcReq["id"], result: unknown) => ({ jsonrpc: "2.0", id: id ?? null, result });
const rpcError = (id: RpcReq["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

async function handleRpc(req: RpcReq): Promise<unknown | null> {
  const { id, method, params = {} } = req;

  if (method.startsWith("notifications/")) return null; // no response for notifications

  switch (method) {
    case "initialize":
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          "Google Search Console connector. Start with list_sites to get exact siteUrl values. Performance data is final after about 3 days.",
      });
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: Object.values(tools).map((t) => t.def) });
    case "tools/call": {
      const name = params.name as string;
      const args = (params.arguments ?? {}) as Args;
      const tool = tools[name];
      if (!tool) return rpcError(id, -32602, `Unknown tool: ${name}`);
      try {
        const out = await tool.run(args);
        return rpcResult(id, { content: [{ type: "text", text: JSON.stringify(out, null, 2) }], isError: false });
      } catch (e) {
        return rpcResult(id, { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true });
      }
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, mcp-session-id, mcp-protocol-version, x-mcp-key",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function authorised(req: Request, url: URL): boolean {
  const secret = env("MCP_SECRET");
  const q = url.searchParams.get("key");
  const h = req.headers.get("x-mcp-key");
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  return q === secret || h === secret || bearer === secret;
}

Deno.serve(async (req: Request): Promise<Response> => {
  const url = new URL(req.url);

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  if (!authorised(req, url)) {
    return new Response(JSON.stringify({ error: "unauthorised" }), { status: 401, headers: { ...CORS, "Content-Type": "application/json" } });
  }

  if (req.method === "GET") {
    // No server-initiated SSE stream; stateless server.
    return new Response(JSON.stringify({ ok: true, server: SERVER_INFO, transport: "streamable-http (stateless)" }), {
      status: 200,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: CORS });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify(rpcError(null, -32700, "Parse error")), { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });
  }

  const batch = Array.isArray(body) ? body as RpcReq[] : [body as RpcReq];
  const responses = (await Promise.all(batch.map(handleRpc))).filter((r) => r !== null);

  if (responses.length === 0) return new Response(null, { status: 202, headers: CORS }); // notifications only

  const payload = Array.isArray(body) ? responses : responses[0];
  return new Response(JSON.stringify(payload), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
});
