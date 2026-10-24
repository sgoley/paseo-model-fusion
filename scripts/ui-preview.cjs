const { execFileSync } = require("node:child_process");
const { realpathSync, mkdirSync, writeFileSync, readFileSync } = require("node:fs");
const { dirname, join } = require("node:path");
const http = require("node:http");
const root = dirname(dirname(realpathSync(execFileSync("which", ["paseo"], { encoding: "utf8" }).trim())));
const esbuild = require(join(root, "node_modules/esbuild"));
const output = join(require("node:os").tmpdir(), "model-fusion-ui-preview");
mkdirSync(output, { recursive: true });
esbuild.buildSync({
  entryPoints: ["scripts/ui-preview.tsx"], bundle: true, outfile: join(output, "bundle.js"), platform: "browser",
  alias: {
    "react-native": join(process.cwd(), "scripts/ui-native.tsx"),
    "@getpaseo/plugin/client": join(process.cwd(), "node_modules/@getpaseo/plugin/dist/client/rpc-context.js"),
  },
  define: { "process.env.NODE_ENV": '"development"' }, jsx: "automatic",
});
writeFileSync(join(output, "index.html"), '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Model Fusion UI preview</title><style>*{box-sizing:border-box}body{margin:0;font-family:system-ui}button,input,textarea{font-family:inherit}button:focus-visible,input:focus-visible,textarea:focus-visible{outline:2px solid #6ba3ff;outline-offset:2px}#root{height:100vh}</style></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
const host = process.env.FUSION_PREVIEW_HOST || "127.0.0.1";
const port = Number(process.env.FUSION_PREVIEW_PORT || 31339);
const server = http.createServer((request, response) => {
  const pathname = new URL(request.url, "http://localhost").pathname;
  if (pathname !== "/" && pathname !== "/bundle.js") { response.writeHead(404).end(); return; }
  response.writeHead(200, { "Content-Type": pathname === "/" ? "text/html" : "application/javascript", "Cache-Control": "no-store" });
  response.end(readFileSync(join(output, pathname === "/" ? "index.html" : "bundle.js")));
});
server.listen(port, host, () => console.log("Fixture preview: http://" + host + ":" + port));
