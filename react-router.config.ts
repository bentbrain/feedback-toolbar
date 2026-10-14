import type { Config } from '@react-router/dev/config';

export default {
  appDirectory: 'src/browser/dashboard',
  buildDirectory: 'dist/dashboard',
  ssr: false,
  routeDiscovery: { mode: 'initial' },
} satisfies Config;
