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
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

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

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
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
    }),
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(
      `Browserless screenshot failed (${response.status} ${response.statusText}): ${details}`
    );
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  return {
    image: bytes.toString("base64"),
    contentType: response.headers.get("content-type") || "image/png",
  };
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
      const [htmlResult, screenshotResult] = await Promise.all([
        fetchHtmlFromBrowserless(targetUrl),
        fetchScreenshotFromBrowserless(targetUrl),
      ]);
      if (!htmlResult.body.trim()) {
        sendJson(res, 502, {
          error:
            "Browserless returned an empty response body. Target site may block automation or require different wait settings.",
        });
        return;
      }

      if (isHtmlContentType(htmlResult.contentType, htmlResult.body)) {
        htmlResult.body = await inlineExternalCss(htmlResult.body, targetUrl);
      }

      if (format === "json") {
        sendJson(res, 200, {
          ok: true,
          url: targetUrl,
          html: htmlResult.body,
          image: screenshotResult.image,
          htmlContentType: pickResponseContentType(htmlResult.contentType, htmlResult.body),
          imageContentType: screenshotResult.contentType,
        });
        return;
      }

      res.writeHead(200, {
        ...CORS_HEADERS,
        "Content-Type": pickResponseContentType(htmlResult.contentType, htmlResult.body),
      });
      res.end(htmlResult.body);
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
