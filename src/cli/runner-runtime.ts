import { constants } from 'node:fs';
import { access, realpath, stat, readFile } from 'node:fs/promises';
import { delimiter, dirname, join, resolve, basename } from 'node:path';
import { createRequire } from 'node:module';
import { z } from 'zod';

async function executable(path: string) {
  await access(path, constants.X_OK);
  const canonical = await realpath(path);
  if (!(await stat(canonical)).isFile()) throw new Error('Runner executable must be a file.');
  return canonical;
}

/** Resolve once so version checks, execution and sandbox grants use the same installation. */
export async function resolveRunnerRuntime(searchPath = process.env.PATH ?? '/usr/bin:/bin') {
  let entry: string | undefined;
  for (const directory of searchPath.split(delimiter)) {
    if (!directory) continue;
    try {
      entry = await executable(resolve(directory, 'codex'));
      break;
    } catch {
      // Continue to the next executable on PATH.
    }
  }
  if (!entry) throw new Error('Install Codex CLI 0.161.0 or newer and add it to PATH.');
  // The official npm/pnpm/Bun entrypoint delegates to a platform-specific native binary.
  if (basename(entry) === 'codex.js') {
    const root = dirname(dirname(entry));
    z.object({ name: z.literal('@openai/codex') }).parse(
      JSON.parse(await readFile(join(root, 'package.json'), 'utf8')),
    );
    const architecture =
      process.arch === 'arm64' ? 'aarch64' : process.arch === 'x64' ? 'x86_64' : null;
    const platform =
      process.platform === 'darwin'
        ? 'apple-darwin'
        : process.platform === 'linux'
          ? 'unknown-linux-musl'
          : null;
    if (!architecture || !platform) throw new Error('Unsupported executable adapter platform.');
    const target = `${architecture}-${platform}`;
    const packageName = `@openai/codex-${process.platform}-${process.arch}`;
    try {
      const vendor = join(
        dirname(createRequire(entry).resolve(`${packageName}/package.json`)),
        'vendor',
      );
      entry = await executable(join(vendor, target, 'bin', 'codex'));
    } catch {
      // Older official distributions bundle vendor inside the main package.
      entry = await executable(join(root, 'vendor', target, 'bin', 'codex'));
    }
  }
  const readablePaths = [entry];
  for (const name of ['codex-code-mode-host', 'codex-linux-sandbox']) {
    try {
      readablePaths.push(await executable(join(dirname(entry), name)));
    } catch {
      // Helpers differ between supported platforms and CLI releases.
    }
  }
  return { executable: entry, readablePaths };
}
