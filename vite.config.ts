import { reactRouter } from '@react-router/dev/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import { z } from 'zod';
import { fileURLToPath } from 'node:url';

const release = process.env.GITHUB_SHA;
if (release)
  z.string()
    .regex(/^[a-f0-9]{40}$/)
    .parse(release);
const apiPort = z.coerce
  .number()
  .int()
  .min(1)
  .max(65535)
  .parse(process.env.FEEDBACK_DEV_API_PORT ?? 4312);

export default defineConfig(({ command }) => ({
  base: command === 'build' && release ? `/assets/${release}/` : '/',
  publicDir: false,
  resolve: { alias: { '@': fileURLToPath(new URL('./src/browser', import.meta.url)) } },
  plugins: [
    {
      name: 'external-sonner-styles',
      enforce: 'pre',
      transform(code, id) {
        if (!id.endsWith('/sonner/dist/index.mjs')) return;
        if (code.match(/^__insertCSS\(.*\);$/gm)?.length !== 1)
          throw new Error(
            'Sonner CSS packaging changed. Review the external stylesheet integration.',
          );
        return code.replace(/^__insertCSS\(.*\);$/gm, '');
      },
    },
    tailwindcss(),
    reactRouter(),
  ],
  optimizeDeps: { exclude: ['sonner'] },
  build: { assetsDir: 'dashboard-assets' },
  server: {
    host: '127.0.0.1',
    port: 4310,
    strictPort: true,
    proxy: Object.fromEntries(
      [
        '/api',
        '/toolbar',
        '/embed.js',
        '/embed-module.js',
        '/toolbar.js',
        '/styles.css',
        '/icon.svg',
        '/health',
      ].map((path) => [path, { target: `http://127.0.0.1:${apiPort}` }]),
    ),
  },
}));
