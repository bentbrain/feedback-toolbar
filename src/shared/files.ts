import { constants } from 'node:fs';
import { open, mkdtemp, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export async function readRegularFile(path: string) {
  if (process.platform === 'win32')
    throw new Error('Use WSL for secure file operations; this command requires O_NOFOLLOW.');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('Choose a regular file, not a directory or special file.');
    return { contents: await handle.readFile(), mode: stat.mode & 0o777 };
  } finally {
    await handle.close();
  }
}

export async function replaceFile(path: string, contents: string, mode: number) {
  const directory = await mkdtemp(join(dirname(path), '.feedback-toolbar-'));
  const temporary = join(directory, 'content');
  try {
    const handle = await open(temporary, 'wx', mode);
    try {
      await handle.writeFile(contents);
      await handle.chmod(mode);
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
