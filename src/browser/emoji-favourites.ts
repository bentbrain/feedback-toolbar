import { z } from 'zod';
import { emojiSchema } from '../shared/models.js';

const historySchema = z.array(z.object({ emoji: emojiSchema, count: z.number().int().positive() }));
type History = z.infer<typeof historySchema>;
const memory = new Map<string, History>();
const storageKey = (actorId: string) => `feedback-emoji-favourites-v1:${actorId}`;

function readHistory(actorId: string): History {
  const cached = memory.get(actorId);
  if (cached) return cached;
  try {
    const result = historySchema.safeParse(
      JSON.parse(localStorage.getItem(storageKey(actorId)) ?? '[]'),
    );
    if (result.success) {
      memory.set(actorId, result.data);
      return result.data;
    }
  } catch {
    // Embedded browsers can deny storage access. Keep choices for this session.
  }
  return memory.get(actorId) ?? [];
}

export function getEmojiFavourites(actorId: string): string[] {
  return readHistory(actorId)
    .toSorted((a, b) => b.count - a.count)
    .slice(0, 8)
    .map(({ emoji }) => emoji);
}

export function recordEmojiChoice(actorId: string, emoji: string): void {
  const history = readHistory(actorId);
  const count = (history.find((entry) => entry.emoji === emoji)?.count ?? 0) + 1;
  const updated = [{ emoji, count }, ...history.filter((entry) => entry.emoji !== emoji)].slice(
    0,
    32,
  );
  memory.set(actorId, updated);
  try {
    localStorage.setItem(storageKey(actorId), JSON.stringify(updated));
  } catch {
    // The in-memory history still works when storage is unavailable or full.
  }
}
