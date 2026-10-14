import { defineConfig, devices } from '@playwright/test';
import config from './playwright.config.js';

export default defineConfig({
  ...config,
  testMatch: 'theme.spec.ts',
  projects: [
    {
      name: 'chromium-native-dark',
      use: {
        ...devices['Desktop Chrome'],
        channel: 'chromium',
        colorScheme: null,
        launchOptions: { args: ['--force-dark-mode'] },
      },
    },
    { name: 'webkit-mobile', use: { ...devices['iPhone 13'], colorScheme: 'dark' } },
  ],
});
