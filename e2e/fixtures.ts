import { test as base, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

// A fresh real service per test isolates account data and native rate-limit buckets.
export const test = base.extend<{ service: boolean }>({
  service: [
    async ({ baseURL }, use) => {
      if (baseURL !== 'http://localhost:44320')
        throw new Error('Unexpected browser fixture origin');
      await mkdir('.data', { recursive: true, mode: 0o700 });
      const directory = await mkdtemp('.data/browser-');
      const server = spawn(process.execPath, ['dist/server.js'], {
        env: {
          ...process.env,
          PORT: '44320',
          DEMO_PORT: '44321',
          FEEDBACK_URL: baseURL,
          FEEDBACK_DATA_DIR: directory,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let diagnostic = '';
      server.stdout.on('data', (chunk: Buffer) => {
        diagnostic = (diagnostic + chunk.toString()).slice(-4000);
      });
      server.stderr.on('data', (chunk: Buffer) => {
        diagnostic = (diagnostic + chunk.toString()).slice(-4000);
      });
      const exited = () => server.exitCode !== null || server.signalCode !== null;
      const closed = new Promise<void>((resolve) => {
        server.once('exit', () => {
          resolve();
        });
      });
      try {
        const deadline = Date.now() + 25_000;
        let ready = false;
        while (Date.now() < deadline && !exited()) {
          if (diagnostic.includes(`Feedback service: ${baseURL}`)) {
            try {
              ready = (await fetch(`${baseURL}/health`, { signal: AbortSignal.timeout(1000) })).ok;
            } catch {
              /* Booting. */
            }
            if (ready) break;
          }
          await delay(100);
        }
        if (!ready || exited()) throw new Error(`Browser fixture did not start: ${diagnostic}`);
        await use(true);
      } finally {
        if (!exited()) {
          server.kill('SIGTERM');
          const stopped = await Promise.race([
            closed.then(() => true),
            delay(5000).then(() => false),
          ]);
          if (!stopped) {
            server.kill('SIGKILL');
            await closed;
          }
        }
        await rm(directory, { recursive: true, force: true });
      }
    },
    { auto: true },
  ],
});
export { expect };
