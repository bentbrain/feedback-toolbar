import data from 'emojibase-data/en/data.json' with { type: 'json' };
import messages from 'emojibase-data/en/messages.json' with { type: 'json' };
import { digest } from './security.js';
import { emojiSchema } from '../shared/models.js';

function canonicalEmoji(emoji: string) {
  // Emojibase adds redundant VS16 selectors to some emoji-presentation characters.
  return emojiSchema.safeParse(emoji).success
    ? emoji
    : emojiSchema.parse(emoji.replace(/\uFE0F/g, ''));
}
const pickerData = data
  .filter((emoji) => emoji.group !== undefined)
  .map((emoji) => ({
    ...emoji,
    emoji: canonicalEmoji(emoji.emoji),
    ...(emoji.skins
      ? { skins: emoji.skins.map((skin) => ({ ...skin, emoji: canonicalEmoji(skin.emoji) })) }
      : {}),
  }));

const license =
  'MIT License\n\nCopyright (c) 2017-2019 Miles Johnson\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the "Software"), to deal\nin the Software without restriction, including without limitation the rights\nto use, copy, modify, merge, publish, distribute, sublicense, and/or sell\ncopies of the Software, and to permit persons to whom the Software is\nfurnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\nIMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\nFITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\nAUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\nLIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\nOUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\nSOFTWARE.\n';
function asset(contents: string, type: string) {
  return { contents, type, etag: `"${digest(contents)}"` };
}
const files = new Map([
  ['data.json', asset(JSON.stringify(pickerData), 'application/json')],
  ['messages.json', asset(JSON.stringify(messages), 'application/json')],
  ['license.txt', asset(license, 'text/plain')],
]);
export function emojiDataResponse(file: string) {
  const item = files.get(file);
  if (!item) return Response.json({ error: 'Not found.' }, { status: 404 });
  return new Response(item.contents, {
    headers: {
      'Content-Type': `${item.type}; charset=utf-8`,
      'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400',
      ETag: item.etag,
      Link: '</api/emoji-data/v1/en/license.txt>; rel="license"',
    },
  });
}
