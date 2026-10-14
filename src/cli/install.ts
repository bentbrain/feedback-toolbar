import { writeFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { readRegularFile, replaceFile } from '../shared/files.js';

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
  const opened = await readRegularFile(file);
  const source = opened.contents.toString('utf8');
  const next = injectHtml(source, snippet);
  if (source === next) return { path: file, changed: false };
  const backup = `${file}.feedback-toolbar.bak`;
  try {
    await writeFile(backup, source, { flag: 'wx', mode: opened.mode });
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
  }
  await replaceFile(file, next, opened.mode);
  return { path: file, changed: true, backup };
}
