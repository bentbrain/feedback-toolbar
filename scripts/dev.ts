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
const build = spawn(process.execPath, ['--import', 'tsx', 'scripts/build.ts'], {
  stdio: 'inherit',
});
const code = await new Promise<number>((resolve, reject) => {
  build.once('error', reject);
  build.once('exit', (code) => {
    resolve(code ?? 1);
  });
});
if (code !== 0) throw new Error('The development build failed.');
const server = await createServer({ server: { port } });
const api = spawn(process.execPath, ['--import', 'tsx', 'src/server/main.ts'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    PORT: String(apiPort),
    FEEDBACK_URL: `http://localhost:${port}`,
    FEEDBACK_DEV_API_PORT: String(apiPort),
  },
});
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  api.kill('SIGTERM');
  await server.close();
};
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void stop());
api.once('exit', () => {
  if (!stopping) process.exitCode = 1;
  void stop();
});
api.once('error', (failure) => {
  console.error(failure.message);
  process.exitCode = 1;
  void stop();
});
try {
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (api.exitCode !== null || api.signalCode !== null)
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
  await server.listen();
  console.log(`Dashboard with hot updates: http://localhost:${port}`);
} catch (failure) {
  await stop();
  throw failure;
}
