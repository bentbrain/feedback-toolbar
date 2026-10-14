import { useCallback, useRef, useState } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import { z } from 'zod';
import { publicJobSchema } from '../shared/models.js';
import type { Thread } from '../shared/models.js';
import { ApiError } from './ui.js';

type MutationRequest = (
  path: string,
  options: { method: string; body: unknown },
) => Promise<unknown>;

// Keep the same key when the response is lost: the server may already have queued the job.
export async function requestWork(
  thread: Thread,
  keys: Map<string, string>,
  api: MutationRequest,
): Promise<unknown> {
  const identity = `${thread.id}:${thread.revision}`;
  const idempotencyKey = keys.get(identity) ?? crypto.randomUUID();
  keys.set(identity, idempotencyKey);
  try {
    const result = await api(`/api/threads/${thread.id}/work`, {
      method: 'POST',
      body: { revision: thread.revision, idempotencyKey },
    });
    const response = z.object({ job: publicJobSchema }).parse(result);
    keys.delete(identity);
    return response;
  } catch (error) {
    if (error instanceof ApiError && error.status < 500 && error.status !== 408)
      keys.delete(identity);
    throw error;
  }
}

// Async acknowledgements compare against the latest accepted state, not their render's snapshot.
export function useMutationState<
  T extends Thread | Thread[] | z.infer<typeof publicJobSchema>[] | null,
>(initial: T): [T, Dispatch<SetStateAction<T>>, RefObject<T>] {
  const [state, render] = useState(initial);
  const current = useRef(initial);
  const update = useCallback((next: SetStateAction<T>) => {
    const value = typeof next === 'function' ? next(current.current) : next;
    current.current = value;
    render(value);
  }, []);
  return [state, update, current];
}

export function newestThread(incoming: Thread, known: (Thread | null)[]): Thread {
  return known.reduce<Thread>(
    (latest, candidate) =>
      candidate?.id === incoming.id && candidate.revision > latest.revision ? candidate : latest,
    incoming,
  );
}

export function newestJob(
  incoming: z.infer<typeof publicJobSchema>,
  known: z.infer<typeof publicJobSchema>[],
): z.infer<typeof publicJobSchema> {
  const previous = known.find((item) => item.id === incoming.id);
  if (!previous) return incoming;
  const rank = (status: z.infer<typeof publicJobSchema>['status']) =>
    status === 'queued' ? 0 : status === 'running' ? 1 : 2;
  return previous.updatedAt > incoming.updatedAt ||
    (previous.updatedAt === incoming.updatedAt && rank(previous.status) > rank(incoming.status))
    ? previous
    : incoming;
}
