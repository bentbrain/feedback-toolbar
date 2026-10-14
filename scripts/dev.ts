import { spawn } from 'node:child_process';
import { get } from 'node:http';
import { createServer } from 'vite';
import { z } from 'zod';

const port = z.coerce
  .number()
  .int()
  .min(1)
  .max(65535)
  .parse(process.env.PORT ?? 4310);
const apiPort = z.coerce
  .number()
  .int()
  .min(1)
  .max(65535)
  .parse(process.env.FEEDBACK_DEV_API_PORT ?? 4312);
if (port === apiPort) throw new Error('The dashboard and API development ports must differ.');
let stopping = false;
const isStopping = () => stopping;
let build: import('node:child_process').ChildProcess | undefined;
let server: Awaited<ReturnType<typeof createServer>> | undefined;
let api: import('node:child_process').ChildProcess | undefined;
const stop = async () => {
  if (isStopping()) return;
  stopping = true;
  if (build?.pid && build.exitCode === null && build.signalCode === null) {
    if (process.platform === 'win32') build.kill('SIGTERM');
    else process.kill(-build.pid, 'SIGTERM');
  }
  api?.kill('SIGTERM');
  await server?.close();
};
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void stop());

async function start() {
  const activeBuild = spawn(process.execPath, ['--import', 'tsx', 'scripts/build.ts'], {
    stdio: 'inherit',
    detached: process.platform !== 'win32',
  });
  build = activeBuild;
  const code = await new Promise<number>((resolve, reject) => {
    activeBuild.once('error', reject);
    activeBuild.once('exit', (code) => {
      resolve(code ?? 1);
    });
  });
  if (isStopping()) return;
  if (code !== 0) throw new Error('The development build failed.');
  const activeServer = await createServer({ server: { port } });
  server = activeServer;
  if (isStopping()) {
    await activeServer.close();
    return;
  }
  const activeApi = spawn(process.execPath, ['--import', 'tsx', 'src/server/main.ts'], {
    stdio: 'inherit',
    env: {
      ...process.env,
      PORT: String(apiPort),
      FEEDBACK_URL: `http://localhost:${port}`,
      FEEDBACK_DEV_API_PORT: String(apiPort),
    },
  });
  api = activeApi;
  activeApi.once('exit', () => {
    if (!stopping) process.exitCode = 1;
    void stop();
  });
  activeApi.once('error', (failure) => {
    console.error(failure.message);
    process.exitCode = 1;
    void stop();
  });
  try {
    const deadline = Date.now() + 20_000;
    for (;;) {
      if (activeApi.exitCode !== null || activeApi.signalCode !== null)
        throw new Error('The development API stopped before becoming ready.');
      try {
        const healthy = await new Promise<boolean>((resolve, reject) => {
          const probe = get(
            `http://127.0.0.1:${apiPort}/health`,
            {
              signal: AbortSignal.timeout(1000),
              headers: { Host: `localhost:${port}` },
            },
            (response) => {
              response.resume();
              resolve(response.statusCode === 200);
            },
          );
          probe.once('error', reject);
        });
        if (healthy) break;
      } catch {
        // The API is still opening its database and authentication service.
      }
      if (Date.now() >= deadline) throw new Error('The development API did not become ready.');
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 100);
      });
    }
    if (isStopping()) return;
    await activeServer.listen();
    console.log(`Dashboard with hot updates: http://localhost:${port}`);
  } catch (failure) {
    await stop();
    throw failure;
  }
}
await start().catch(async (failure: unknown) => {
  await stop();
  throw failure;
});
