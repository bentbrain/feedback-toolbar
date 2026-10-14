import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: { baseURL: 'http://localhost:44320', trace: 'off', screenshot: 'only-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node dist/server.js',
    url: 'http://localhost:44320/health',
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      PORT: '44320',
      DEMO_PORT: '44321',
      FEEDBACK_URL: 'http://localhost:44320',
      FEEDBACK_DATA_DIR: `.data/e2e-${process.pid}`,
    },
  },
});
