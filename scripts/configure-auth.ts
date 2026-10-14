import { spawn } from 'node:child_process';
import { z } from 'zod';

const configuration = z
  .object({
    FEEDBACK_PROXY_SECRET: z.string().min(32),
    BETTER_AUTH_SECRET: z.string().min(32),
    AUTH_GITHUB_CLIENT_ID: z.string().min(1),
    AUTH_GITHUB_CLIENT_SECRET: z.string().min(1),
  })
  .safeParse(process.env);
if (!configuration.success)
  throw new Error(
    'Configure BETTER_AUTH_SECRET, AUTH_GITHUB_CLIENT_ID and AUTH_GITHUB_CLIENT_SECRET before deploying.',
  );
const worker = spawn('bunx', ['wrangler', 'secret', 'bulk'], {
  stdio: ['pipe', 'inherit', 'inherit'],
});
worker.stdin.end(JSON.stringify(configuration.data));
await new Promise<void>((resolve, reject) => {
  worker.once('error', reject);
  worker.once('exit', (code) => {
    if (code === 0) resolve();
    else reject(new Error('Worker authentication secrets could not be configured.'));
  });
});
