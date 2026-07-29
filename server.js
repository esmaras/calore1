#!/usr/bin/env node
// Zero-dependency local server for the Calore 1 campaign tracker.
// Serves the static UI from ./public and a tiny JSON read/write API
// backed by ./data.json.

const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_FILE = path.join(ROOT, "data.json");
const PORT = process.env.PORT || 4173;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}

function serveStatic(req, res) {
  let reqPath = decodeURIComponent(req.url.split("?")[0]);
  if (reqPath === "/") reqPath = "/index.html";
  const filePath = path.normalize(path.join(PUBLIC_DIR, reqPath));

  // Prevent path traversal outside the public dir.
  if (!filePath.startsWith(PUBLIC_DIR)) {
    return send(res, 403, "Forbidden");
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      return send(res, 404, "Not found");
    }
    const ext = path.extname(filePath);
    send(res, 200, content, { "Content-Type": MIME[ext] || "application/octet-stream" });
  });
}

function handleGetData(req, res) {
  fs.readFile(DATA_FILE, "utf8", (err, content) => {
    if (err) return send(res, 500, JSON.stringify({ error: "Could not read data.json" }), { "Content-Type": MIME[".json"] });
    send(res, 200, content, { "Content-Type": MIME[".json"] });
  });
}

function handlePostData(req, res) {
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
    if (body.length > 25 * 1024 * 1024) req.destroy(); // 25MB safety cap
  });
  req.on("end", () => {
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch (e) {
      return send(res, 400, JSON.stringify({ error: "Invalid JSON" }), { "Content-Type": MIME[".json"] });
    }
    const text = JSON.stringify(parsed, null, 2);
    // Write to a temp file first, then rename, so a crash mid-write can't corrupt data.json.
    const tmpFile = DATA_FILE + ".tmp";
    fs.writeFile(tmpFile, text, (err) => {
      if (err) return send(res, 500, JSON.stringify({ error: "Write failed" }), { "Content-Type": MIME[".json"] });
      fs.rename(tmpFile, DATA_FILE, (err2) => {
        if (err2) return send(res, 500, JSON.stringify({ error: "Write failed" }), { "Content-Type": MIME[".json"] });
        send(res, 200, JSON.stringify({ ok: true }), { "Content-Type": MIME[".json"] });
      });
    });
  });
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith("/api/data")) {
    if (req.method === "GET") return handleGetData(req, res);
    if (req.method === "POST") return handlePostData(req, res);
    return send(res, 405, "Method not allowed");
  }
  if (req.method === "GET") return serveStatic(req, res);
  send(res, 405, "Method not allowed");
});

server.listen(PORT, () => {
  console.log(`Calore 1 campaign tracker running at http://localhost:${PORT}`);
});
