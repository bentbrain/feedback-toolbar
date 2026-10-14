import { z } from 'zod';
import { emojiSchema } from '../shared/models.js';

const historySchema = z.array(z.object({ emoji: emojiSchema, count: z.number().int().positive() }));
type History = z.infer<typeof historySchema>;
const memory = new Map<string, History>();
const memoryOnly = new Set<string>();
const storageKey = (actorId: string) => `feedback-emoji-favourites-v1:${actorId}`;

function readHistory(actorId: string): History {
  if (memoryOnly.has(actorId)) return memory.get(actorId) ?? [];
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
    memoryOnly.add(actorId);
  }
  return memory.get(actorId) ?? [];
}

export function getEmojiFavourites(actorId: string): string[] {
  return readHistory(actorId)
    .toSorted((a, b) => b.count - a.count)
    .slice(0, 8)
    .map(({ emoji }) => emoji);
}

function updateHistory(actorId: string, emoji: string, persist: boolean): void {
  const history = readHistory(actorId);
  const count = (history.find((entry) => entry.emoji === emoji)?.count ?? 0) + 1;
  const updated = [{ emoji, count }, ...history.filter((entry) => entry.emoji !== emoji)];
  memory.set(actorId, updated);
  if (!persist || memoryOnly.has(actorId)) {
    memoryOnly.add(actorId);
    return;
  }
  try {
    localStorage.setItem(storageKey(actorId), JSON.stringify(updated));
  } catch {
    // The in-memory history still works when storage is unavailable or full.
    memoryOnly.add(actorId);
  }
}

export async function recordEmojiChoice(actorId: string, emoji: string): Promise<void> {
  const browser: { locks?: LockManager } = navigator;
  if (browser.locks) {
    try {
      await browser.locks.request(storageKey(actorId), () => {
        updateHistory(actorId, emoji, true);
      });
      return;
    } catch {
      // Without a shared lock, keep this frame's choices in memory to avoid lost writes.
    }
  }
  updateHistory(actorId, emoji, false);
}
