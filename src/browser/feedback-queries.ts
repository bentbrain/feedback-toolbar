import { useEffect } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import type { InfiniteData } from '@tanstack/react-query';
import { z } from 'zod';
import { publicJobSchema, threadSchema } from '../shared/models.js';
import { newestJob, newestThread } from './mutations.js';
import { request } from './ui.js';

const pageSchema = z.object({
  threads: z.array(threadSchema),
  jobs: z.array(publicJobSchema),
  nextBefore: z.number().nullable(),
});
const detailSchema = z.object({ thread: threadSchema, jobs: z.array(publicJobSchema) });
type FeedbackPage = z.infer<typeof pageSchema>;
type FeedbackData = InfiniteData<FeedbackPage, number | null>;
type Detail = z.infer<typeof detailSchema>;
type Job = z.infer<typeof publicJobSchema>;

function mergeJobs(jobs: Job[]): Job[] {
  const merged = new Map<string, Job>();
  for (const job of jobs) {
    const previous = merged.get(job.id);
    merged.set(job.id, newestJob(job, previous ? [previous] : []));
  }
  return [...merged.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function useFeedback(
  projectId: string,
  search: string,
  filter: string,
  activeId: string | null,
) {
  const client = useQueryClient();
  const listKey = ['feedback', projectId, search, filter];
  const detailKey = ['thread', projectId, activeId];
  const feedback = useInfiniteQuery<FeedbackPage, Error, FeedbackData, string[], number | null>({
    queryKey: listKey,
    queryFn: async ({ pageParam, signal }) => {
      const params = new URLSearchParams({ q: search });
      if (filter !== 'all') params.set('status', filter);
      if (pageParam !== null) params.set('before', String(pageParam));
      const page = pageSchema.parse(
        await request(`/api/projects/${projectId}/threads?${params}`, { signal }),
      );
      const known = client.getQueryData<FeedbackData>(listKey)?.pages ?? [];
      const knownThreads = known.flatMap((page) => page.threads);
      const knownJobs = mergeJobs(known.flatMap((page) => page.jobs));
      return {
        ...page,
        threads: page.threads.map((thread) => newestThread(thread, knownThreads)),
        jobs: page.jobs.map((job) => newestJob(job, knownJobs)),
      };
    },
    initialPageParam: null,
    getNextPageParam: (page) => page.nextBefore,
    enabled: !!projectId,
    // Keep results across filters/searches, but never across projects.
    placeholderData: (previous, query) => (query?.queryKey[1] === projectId ? previous : undefined),
    refetchInterval: 10_000,
  });
  const detail = useQuery({
    queryKey: detailKey,
    queryFn: async ({ signal }) => {
      const incoming = detailSchema.parse(await request(`/api/threads/${activeId}`, { signal }));
      const previous = client.getQueryData<Detail>(detailKey);
      return {
        thread: newestThread(incoming.thread, [previous?.thread ?? null]),
        jobs: incoming.jobs.map((job) => newestJob(job, previous?.jobs ?? [])),
      };
    },
    enabled: !!projectId && !!activeId,
    refetchInterval: 10_000,
  });
  const threads = feedback.data?.pages.flatMap((page) => page.threads) ?? [];
  const summaryRevision = threads.find((thread) => thread.id === activeId)?.revision;
  const detailRevision = detail.data?.thread.revision;
  useEffect(() => {
    if (
      summaryRevision !== undefined &&
      detailRevision !== undefined &&
      summaryRevision > detailRevision
    )
      void client.invalidateQueries({ queryKey: ['thread', projectId, activeId] });
  }, [client, projectId, activeId, summaryRevision, detailRevision]);
  // Detail supplies the authoritative order for runs with identical timestamps.
  const jobs = mergeJobs([
    ...(detail.data?.jobs ?? []),
    ...(feedback.data?.pages.flatMap((page) => page.jobs) ?? []),
  ]);
  const acceptThread = async (result: unknown) => {
    const received = z.object({ thread: threadSchema }).parse(result).thread;
    if (received.projectId !== projectId) return;
    await Promise.all([
      client.cancelQueries({ queryKey: ['feedback', projectId] }),
      client.cancelQueries({ queryKey: ['thread', projectId, received.id] }),
    ]);
    const key = ['thread', projectId, received.id];
    const previous = client.getQueryData<Detail>(key);
    const known = client
      .getQueriesData<FeedbackData>({ queryKey: ['feedback', projectId] })
      .flatMap(([, data]) => data?.pages.flatMap((page) => page.threads) ?? []);
    // List entries are summaries, so they must never enter the full-detail cache.
    const thread = newestThread(received, [previous?.thread ?? null]);
    client.setQueryData<Detail>(key, { thread, jobs: previous?.jobs ?? [] });
    client.setQueriesData<FeedbackData>(
      { queryKey: ['feedback', projectId] },
      (data) =>
        data && {
          ...data,
          pages: data.pages.map((page) => ({
            ...page,
            threads: page.threads.map((item) =>
              item.id === thread.id ? newestThread(thread, [item]) : item,
            ),
          })),
        },
    );
    if (known.some((item) => item.id === thread.id && item.revision > thread.revision))
      void client.invalidateQueries({ queryKey: key });
    void client.invalidateQueries({ queryKey: ['feedback', projectId] });
  };
  const acceptJob = async (result: unknown) => {
    const response = z
      .object({ job: publicJobSchema, thread: threadSchema.optional() })
      .parse(result);
    if (response.thread) await acceptThread({ thread: response.thread });
    const received = response.job;
    await Promise.all([
      client.cancelQueries({ queryKey: ['feedback', projectId] }),
      client.cancelQueries({ queryKey: ['thread', projectId, received.threadId] }),
    ]);
    const key = ['thread', projectId, received.threadId];
    const previous = client.getQueryData<Detail>(key);
    const known = client
      .getQueriesData<FeedbackData>({ queryKey: ['feedback', projectId] })
      .flatMap(([, data]) => data?.pages.flatMap((page) => page.jobs) ?? []);
    const job = newestJob(received, mergeJobs([...known, ...(previous?.jobs ?? [])]));
    const update = (jobs: Job[]) => mergeJobs([...jobs, job]);
    client.setQueryData<Detail>(key, (data) => data && { ...data, jobs: update(data.jobs) });
    client.setQueriesData<FeedbackData>(
      { queryKey: ['feedback', projectId] },
      (data) =>
        data && {
          ...data,
          pages: data.pages.map((page) => ({ ...page, jobs: update(page.jobs) })),
        },
    );
    void Promise.all([
      client.invalidateQueries({ queryKey: ['feedback', projectId] }),
      client.invalidateQueries({ queryKey: key }),
    ]);
    return job;
  };
  return { feedback, detail, threads, jobs, acceptThread, acceptJob };
}
