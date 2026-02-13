const http = require("node:http");

const PORT = Number(process.env.PORT || 3000);
const BROWSERLESS_URL =
  process.env.BROWSERLESS_URL || "https://production-sfo.browserless.io/content";
const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN;
const SELF_PING_INTERVAL_MS = 5 * 60 * 1000;

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
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
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

  let parsed;
  try {
    parsed = JSON.parse(raw);
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

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: targetUrl }),
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
}

function pickResponseContentType(contentType, body) {
  if (contentType && contentType.trim()) return contentType;
  const trimmed = body.trimStart().toLowerCase();
  if (trimmed.startsWith("<!doctype html") || trimmed.startsWith("<html")) {
    return "text/html; charset=utf-8";
  }
  return "text/plain; charset=utf-8";
}

const server = http.createServer(async (req, res) => {
  logRequestReceived(req);

  if (req.method === "GET" && req.url === "/health") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && req.url === "/fetch") {
    try {
      const rawBody = await readRequestBody(req);
      const payload = parseFetchBody(rawBody);

      if (!payload || typeof payload.url !== "string" || !payload.url.trim()) {
        sendJson(res, 400, {
          error:
            'Invalid body. Send JSON like {"url":"https://example.com"} or a JSON string containing that object.',
        });
        return;
      }

      const targetUrl = payload.url.trim();
      console.log(
        `[${new Date().toISOString()}] Fetching target url="${targetUrl}" via Browserless`
      );
      const result = await fetchHtmlFromBrowserless(targetUrl);
      res.writeHead(200, {
        "Content-Type": pickResponseContentType(result.contentType, result.body),
      });
      res.end(result.body);
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
