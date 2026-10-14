import { readFile, writeFile, rename, lstat } from 'node:fs/promises';
import { resolve, extname } from 'node:path';

const start = '<!-- feedback-toolbar:start -->';
const end = '<!-- feedback-toolbar:end -->';
export function injectHtml(source: string, snippet: string): string {
  const begin = source.indexOf(start);
  const finish = source.indexOf(end);
  const block = `${start}\n${snippet}\n${end}`;
  if (begin >= 0 || finish >= 0) {
    if (
      begin < 0 ||
      finish < begin ||
      source.includes(start, begin + start.length) ||
      source.includes(end, finish + end.length)
    )
      throw new Error(
        'Installation markers are incomplete or duplicated. Repair them before retrying.',
      );
    return source.slice(0, begin) + block + source.slice(finish + end.length);
  }
  const matches = [...source.matchAll(/<\/head\s*>/gi)];
  if (matches.length !== 1 || !matches[0])
    throw new Error(
      'Expected one closing </head>. Use the returned snippet to edit your shared layout.',
    );
  const index = matches[0].index;
  return source.slice(0, index) + `${block}\n` + source.slice(index);
}
export async function installHtml(path: string, snippet: string) {
  if (!['.html', '.htm'].includes(extname(path).toLowerCase()))
    throw new Error(
      '--file supports HTML entry points. For framework layouts, use the installation manifest to make a source edit.',
    );
  const file = resolve(path);
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error('Choose a regular HTML file, not a symlink.');
  const source = await readFile(file, 'utf8');
  const next = injectHtml(source, snippet);
  if (source === next) return { path: file, changed: false };
  const backup = `${file}.feedback-toolbar.bak`;
  try {
    await writeFile(backup, source, { flag: 'wx', mode: stat.mode });
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
  }
  const temporary = `${file}.feedback-toolbar.${process.pid}.tmp`;
  await writeFile(temporary, next, { mode: stat.mode });
  await rename(temporary, file);
  return { path: file, changed: true, backup };
}
