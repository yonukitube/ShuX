const path = require("path");
const fs = require("fs");
const http = require("http");
const root = path.join(__dirname, "public");

http.createServer((req, res) => {
  if (req.url.startsWith('/api/')) {
    const apiPath = req.url.slice(4);
    let token;
    try {
      token = fs.readFileSync(
        path.join(require("os").homedir(), ".shux-api-token"), "utf8"
      ).trim();
    } catch {
      res.writeHead(500);
      return res.end("ShuX API token unavailable");
    }

    const options = {
      hostname: "127.0.0.1",
      port: 8765,
      path: apiPath,
      method: req.method,
      headers: { "Authorization": "Bearer " + token }
    };

    const proxy = http.request(options, upstream => {
      res.writeHead(upstream.statusCode, {
        "Content-Type": upstream.headers["content-type"] || "application/json"
      });
      upstream.pipe(res);
    });

    proxy.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end("ShuX API unavailable");
    });

    req.pipe(proxy);
    return;
  }

  const pathname = decodeURIComponent(req.url.split('?')[0]);
  const file = pathname === '/' ? 'index.html' : pathname.slice(1);
  const full = path.resolve(root, file);

  if (!full.startsWith(root + path.sep)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.readFile(full, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }

    const type = full.endsWith('.css')
      ? 'text/css; charset=utf-8'
      : 'text/html; charset=utf-8';

    res.writeHead(200, { 'Content-Type': type });
    res.end(data);
  });
}).listen(5600, '127.0.0.1', () => {
  console.log('ShuX Web: http://127.0.0.1:5600');
});
