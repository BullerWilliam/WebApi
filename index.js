const http = require("node:http");

const PORT = Number(process.env.PORT || 3000);
const BROWSERLESS_URL =
  process.env.BROWSERLESS_URL || "https://production-sfo.browserless.io/content";
const BROWSERLESS_SCREENSHOT_URL =
  process.env.BROWSERLESS_SCREENSHOT_URL ||
  new URL("/screenshot", BROWSERLESS_URL).toString();
const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN;
const SELF_PING_INTERVAL_MS = 5 * 60 * 1000;
const CAPTURE_DELAY_MS = Number(process.env.CAPTURE_DELAY_MS || 5000);
const SCREENSHOT_RETRIES = Number(process.env.SCREENSHOT_RETRIES || 2);
const SCREENSHOT_BACKOFF_MS = Number(process.env.SCREENSHOT_BACKOFF_MS || 1500);
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 10 * 60 * 1000);
const CACHE_MAX_ENTRIES = Number(process.env.CACHE_MAX_ENTRIES || 200);
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};
const fetchCache = new Map();

function purgeExpiredCacheEntries() {
  const now = Date.now();
  for (const [key, entry] of fetchCache.entries()) {
    if (entry.expiresAt <= now) {
      fetchCache.delete(key);
    }
  }
}

function getCacheKey(targetUrl) {
  return targetUrl.trim();
}

function getCachedFetchResult(targetUrl) {
  purgeExpiredCacheEntries();
  const cacheKey = getCacheKey(targetUrl);
  const entry = fetchCache.get(cacheKey);
  if (!entry) return null;

  const msLeft = entry.expiresAt - Date.now();
  if (msLeft <= 0) {
    fetchCache.delete(cacheKey);
    return null;
  }

  return {
    value: entry.value,
    ttlRemainingMs: msLeft,
  };
}

function setCachedFetchResult(targetUrl, value) {
  if (CACHE_TTL_MS <= 0 || CACHE_MAX_ENTRIES <= 0) return;

  purgeExpiredCacheEntries();
  if (fetchCache.size >= CACHE_MAX_ENTRIES) {
    const oldestKey = fetchCache.keys().next().value;
    if (oldestKey !== undefined) fetchCache.delete(oldestKey);
  }

  fetchCache.set(getCacheKey(targetUrl), {
    value,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
}

function getClientIp(req) {
  const forwardedFor = req.headers["x-forwarded-for"];
  if (typeof forwardedFor === "string" && forwardedFor.trim()) {
    return forwardedFor.split(",")[0].trim();
  }
  return req.socket?.remoteAddress || "unknown";
}

function logRequestReceived(req) {
  console.log(
    `[${new Date().toISOString()}] Request received: ${req.method} ${req.url} ip=${getClientIp(
      req
    )} userAgent="${req.headers["user-agent"] || "unknown"}" contentType="${
      req.headers["content-type"] || "unknown"
    }" contentLength="${req.headers["content-length"] || "unknown"}"`
  );
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    ...CORS_HEADERS,
    "Content-Type": "application/json; charset=utf-8",
  });
  res.end(JSON.stringify(payload));
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");

    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1024 * 1024) {
        reject(new Error("Request body too large (max 1MB)."));
        req.destroy();
      }
    });

    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function parseFetchBody(raw) {
  if (!raw || !raw.trim()) return null;

  const trimmed = raw.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    return { url: trimmed };
  }

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }

  if (!parsed || typeof parsed !== "object") return null;
  return parsed;
}

async function fetchHtmlFromBrowserless(targetUrl) {
  if (!BROWSERLESS_TOKEN) {
    throw new Error("Missing BROWSERLESS_TOKEN environment variable.");
  }

  const endpoint = new URL(BROWSERLESS_URL);
  endpoint.searchParams.set("token", BROWSERLESS_TOKEN);

  const requestPayload = {
    url: targetUrl,
    gotoOptions: {
      waitUntil: "networkidle2",
      timeout: 60000,
    },
    waitForTimeout: CAPTURE_DELAY_MS,
    bestAttempt: true,
  };

  const runRequest = async (payload) => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const details = await response.text();
      throw new Error(
        `Browserless request failed (${response.status} ${response.statusText}): ${details}`
      );
    }

    return {
      body: await response.text(),
      contentType: response.headers.get("content-type"),
    };
  };

  let result = await runRequest(requestPayload);
  if (!result.body.trim()) {
    console.warn(
      `[${new Date().toISOString()}] Browserless returned empty body, retrying once for url="${targetUrl}"`
    );
    result = await runRequest({
      ...requestPayload,
      waitForTimeout: CAPTURE_DELAY_MS + 3000,
    });
  }

  return result;
}

async function fetchScreenshotFromBrowserless(targetUrl) {
  if (!BROWSERLESS_TOKEN) {
    throw new Error("Missing BROWSERLESS_TOKEN environment variable.");
  }

  const endpoint = new URL(BROWSERLESS_SCREENSHOT_URL);
  endpoint.searchParams.set("token", BROWSERLESS_TOKEN);

  const requestPayload = {
    url: targetUrl,
    gotoOptions: {
      waitUntil: "networkidle2",
      timeout: 60000,
    },
    waitForTimeout: CAPTURE_DELAY_MS,
    bestAttempt: true,
    options: {
      type: "png",
      fullPage: true,
    },
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  for (let attempt = 0; attempt <= SCREENSHOT_RETRIES; attempt += 1) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestPayload),
    });

    if (response.ok) {
      const bytes = Buffer.from(await response.arrayBuffer());
      return {
        image: bytes.toString("base64"),
        contentType: response.headers.get("content-type") || "image/png",
      };
    }

    const details = await response.text();
    if (response.status === 429 && attempt < SCREENSHOT_RETRIES) {
      const waitMs = SCREENSHOT_BACKOFF_MS * (attempt + 1);
      console.warn(
        `[${new Date().toISOString()}] Screenshot rate-limited (429), retrying in ${waitMs}ms (attempt ${attempt + 1}/${SCREENSHOT_RETRIES})`
      );
      await sleep(waitMs);
      continue;
    }

    throw new Error(
      `Browserless screenshot failed (${response.status} ${response.statusText}): ${details}`
    );
  }

  throw new Error("Browserless screenshot failed after retries.");
}

function pickResponseContentType(contentType, body) {
  if (contentType && contentType.trim()) return contentType;
  const trimmed = body.trimStart().toLowerCase();
  if (trimmed.startsWith("<!doctype html") || trimmed.startsWith("<html")) {
    return "text/html; charset=utf-8";
  }
  return "text/plain; charset=utf-8";
}

function isHtmlContentType(contentType, body) {
  if (contentType && /text\/html|application\/xhtml\+xml/i.test(contentType)) {
    return true;
  }
  const trimmed = body.trimStart().toLowerCase();
  return trimmed.startsWith("<!doctype html") || trimmed.startsWith("<html");
}

function extractStylesheetLinks(html) {
  const links = [];
  const regex = /<link\b[^>]*>/gi;
  let match;
  while ((match = regex.exec(html))) {
    const tag = match[0];
    if (!/\brel\s*=\s*["'][^"']*stylesheet[^"']*["']/i.test(tag)) continue;
    const hrefMatch =
      tag.match(/\bhref\s*=\s*"([^"]+)"/i) || tag.match(/\bhref\s*=\s*'([^']+)'/i);
    if (!hrefMatch) continue;
    links.push({ tag, href: hrefMatch[1] });
  }
  return links;
}

async function inlineExternalCss(html, pageUrl) {
  const links = extractStylesheetLinks(html);
  if (!links.length) return html;

  let out = html;
  for (const link of links) {
    try {
      const cssUrl = new URL(link.href, pageUrl).toString();
      const response = await fetch(cssUrl, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; RenderGateway/1.0)" },
      });
      if (!response.ok) {
        console.warn(
          `[${new Date().toISOString()}] CSS fetch failed url="${cssUrl}" status=${response.status}`
        );
        continue;
      }
      const cssText = await response.text();
      const replacement = `<style data-inlined-from="${cssUrl}">\n${cssText}\n</style>`;
      out = out.replace(link.tag, replacement);
    } catch (err) {
      console.warn(
        `[${new Date().toISOString()}] CSS inline error href="${link.href}" reason="${err.message}"`
      );
    }
  }

  return out;
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const path = requestUrl.pathname;

  logRequestReceived(req);

  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  if (req.method === "GET" && path === "/health") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && path === "/fetch") {
    try {
      const rawBody = await readRequestBody(req);
      console.log(
        `[${new Date().toISOString()}] /fetch body received bytes=${Buffer.byteLength(rawBody, "utf8")}`
      );
      const payload = parseFetchBody(rawBody);

      if (!payload || typeof payload.url !== "string" || !payload.url.trim()) {
        sendJson(res, 400, {
          error:
            'Invalid body. Send JSON like {"url":"https://example.com"} or a JSON string containing that object.',
        });
        return;
      }

      const targetUrl = payload.url.trim();
      const format =
        (typeof payload.format === "string" && payload.format.toLowerCase()) ||
        requestUrl.searchParams.get("format") ||
        "json";
      console.log(
        `[${new Date().toISOString()}] Fetching target url="${targetUrl}" via Browserless format="${format}"`
      );
      let finalHtml;
      let finalHtmlContentType;
      let screenshotResult = null;
      let screenshotWarning = null;

      const cached = getCachedFetchResult(targetUrl);
      if (cached) {
        console.log(
          `[${new Date().toISOString()}] Cache hit for url="${targetUrl}" ttlRemainingMs=${cached.ttlRemainingMs}`
        );
        finalHtml = cached.value.html;
        finalHtmlContentType = cached.value.htmlContentType;
        screenshotResult = cached.value.screenshotResult;
        screenshotWarning = cached.value.screenshotWarning;
      } else {
        console.log(`[${new Date().toISOString()}] Cache miss for url="${targetUrl}"`);
        const htmlResult = await fetchHtmlFromBrowserless(targetUrl);
        if (!htmlResult.body.trim()) {
          sendJson(res, 502, {
            error:
              "Browserless returned an empty response body. Target site may block automation or require different wait settings.",
          });
          return;
        }

        try {
          screenshotResult = await fetchScreenshotFromBrowserless(targetUrl);
        } catch (screenshotErr) {
          screenshotWarning = screenshotErr.message || "Screenshot unavailable.";
          console.warn(
            `[${new Date().toISOString()}] Screenshot skipped for url="${targetUrl}" reason="${screenshotWarning}"`
          );
        }

        if (isHtmlContentType(htmlResult.contentType, htmlResult.body)) {
          htmlResult.body = await inlineExternalCss(htmlResult.body, targetUrl);
        }

        finalHtml = htmlResult.body;
        finalHtmlContentType = pickResponseContentType(htmlResult.contentType, htmlResult.body);
        setCachedFetchResult(targetUrl, {
          html: finalHtml,
          htmlContentType: finalHtmlContentType,
          screenshotResult,
          screenshotWarning,
        });
      }

      if (format === "json") {
        sendJson(res, 200, {
          ok: true,
          url: targetUrl,
          html: finalHtml,
          image: screenshotResult ? screenshotResult.image : null,
          htmlContentType: finalHtmlContentType,
          imageContentType: screenshotResult ? screenshotResult.contentType : null,
          warning: screenshotWarning,
        });
        return;
      }

      res.writeHead(200, {
        ...CORS_HEADERS,
        "Content-Type": finalHtmlContentType,
      });
      res.end(finalHtml);
      return;
    } catch (err) {
      console.error(`[${new Date().toISOString()}] /fetch error: ${err.message}`);
      sendJson(res, 500, { error: err.message || "Internal server error." });
      return;
    }
  }

  sendJson(res, 404, { error: "Not found." });
});

server.listen(PORT, () => {
  console.log(`Gateway listening on port ${PORT}`);
});

function startSelfPing() {
  const pingUrl =
    process.env.SELF_PING_URL ||
    (process.env.RENDER_EXTERNAL_URL
      ? `${process.env.RENDER_EXTERNAL_URL.replace(/\/$/, "")}/health`
      : `http://127.0.0.1:${PORT}/health`);

  const ping = async () => {
    try {
      const response = await fetch(pingUrl);
      if (!response.ok) {
        console.error(`Self ping failed: ${response.status} ${response.statusText}`);
      }
    } catch (err) {
      console.error(`Self ping error: ${err.message}`);
    }
  };

  setInterval(ping, SELF_PING_INTERVAL_MS);
  ping();
}

startSelfPing();
