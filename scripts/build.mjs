import { build } from "esbuild";
import { mkdir, copyFile, writeFile } from "node:fs/promises";
const url =
  process.env.SUPABASE_URL || "https://qmhzollowjbarzbnibdf.supabase.co";
const key =
  process.env.SUPABASE_PUBLISHABLE_KEY ||
  "sb_publishable_CtK4JW3EnOTlej_yJsIQ3Q_iw1XJmai";
if (!/^https?:\/\//.test(url) || /sb_secret|service_role/.test(key))
  throw new Error("Gebruik uitsluitend een openbare Supabase-sleutel.");
await mkdir("dist", { recursive: true });
await build({
  entryPoints: ["src/app.js"],
  outfile: "dist/app.js",
  bundle: true,
  minify: true,
  sourcemap: false,
  define: {
    __SUPABASE_URL__: JSON.stringify(url),
    __SUPABASE_KEY__: JSON.stringify(key),
  },
  target: ["chrome100", "safari15.4", "firefox100"],
  legalComments: "eof",
});
await copyFile("index.html", "dist/index.html");
await copyFile("src/style.css", "dist/app.css");
await writeFile(
  "dist/_headers",
  `/*\n  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' ${url} ${url.replace(/^http/, "ws")}; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: no-referrer\n  Permissions-Policy: camera=(self), microphone=(), geolocation=()\n  Cache-Control: no-cache\n`,
);
console.log("Build klaar in dist/; niets gepubliceerd.");
