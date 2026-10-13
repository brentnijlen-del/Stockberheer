import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/browser",
  testMatch: "*.spec.js",
  workers: 1,
  timeout: 30000,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:8000",
    headless: true,
    launchOptions: {
      executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
      args: ["--no-sandbox", "--disable-crash-reporter", "--disable-breakpad"],
    },
  },
  webServer: {
    command:
      "SUPABASE_URL=http://127.0.0.1:8040 SUPABASE_PUBLISHABLE_KEY=test-public npm run build && node tests/browser/server.mjs",
    url: "http://127.0.0.1:8000",
    reuseExistingServer: false,
  },
});
