import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import data from 'emojibase-data/en/data.json' with { type: 'json' };
import { z } from 'zod';
import { emojiSchema } from '../src/shared/models.js';
import { emojiDataResponse } from '../src/server/emoji-data.js';

void test('single Unicode emoji validation covers flags, skin tones and joined sequences', () => {
  for (const emoji of [
    '👍',
    '❤️',
    '❤',
    '🦋',
    '👍🏽',
    '🇦🇺',
    '🏳️‍🌈',
    '👨‍👩‍👧‍👦',
    '👩🏽‍💻',
    '🧑🏿‍❤️‍💋‍🧑🏻',
    '🏴\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f}',
    '1️⃣',
  ]) {
    assert.equal(emojiSchema.parse(emoji), emoji);
  }
  for (const input of [
    '',
    'hello',
    'https://example.com/😀',
    '😀😀',
    '👍 🦋',
    '😀\n',
    ' 😀',
    '😀 word',
    '1',
    '🇦',
    '😀\u200d',
    'a'.repeat(65),
  ]) {
    assert.equal(emojiSchema.safeParse(input).success, false, JSON.stringify(input));
  }
});

void test('every selectable Emojibase 17 emoji and skin variant passes the API schema', async () => {
  const entry = z.object({ emoji: emojiSchema });
  const entries = z
    .array(entry.extend({ skins: z.array(entry).optional() }))
    .parse(await emojiDataResponse('data.json').json());
  assert.equal(entries.length, data.filter((emoji) => emoji.group !== undefined).length);
  assert.ok(entries.flatMap((emoji) => [emoji, ...(emoji.skins ?? [])]).length > 3900);
  // Canonicalization also keeps the existing quick reaction and picker equivalent.
  assert.ok(entries.some((emoji) => emoji.emoji === '👍'));
  assert.ok(entries.some((emoji) => emoji.emoji === '🇦🇺'));
  assert.ok(entries.some((emoji) => emoji.emoji === '👨‍👩‍👧‍👦'));
});

void test('self-hosted data includes the exact dataset license and rejects unknown files', async () => {
  const license = await readFile(new URL(import.meta.resolve('emojibase-data/LICENSE')), 'utf8');
  assert.equal(await emojiDataResponse('license.txt').text(), license);
  assert.equal(emojiDataResponse('../data.json').status, 404);
});
