import { useEffect, useRef, useState } from 'react';
import { useFeedback } from '../../feedback-queries.js';
import { ArrowUpRight, ExternalLink, MessageCircle, Search, Target, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { messageOf, relativeTime, request } from '../../ui.js';
import { requestWork } from '../../mutations.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Badge } from '../../components/ui/badge.js';
import { Card } from '../../components/ui/card.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog.js';
import { Tabs, TabsList, TabsTrigger } from '../../components/ui/tabs.js';
import {
  Conversation,
  Empty,
  JobBadge,
  PageHeading,
  Person,
  UnsubmittedFeedback,
} from '../../components/common.js';

import { useProject } from '../project-layout.js';

export default function FeedbackRoute() {
  const {
    project: p,
    tryDemo,
    user,
    feedbackFilter: filter,
    setFeedbackFilter: setFilter,
    feedbackSearch: search,
    setFeedbackSearch: setSearch,
  } = useProject();
  const [activeId, setActiveId] = useState<string | null>(null);
  const workKeys = useRef(new Map<string, string>());
  const { feedback, detail, threads, jobs, acceptThread, acceptJob } = useFeedback(
    p.id,
    search,
    filter,
    activeId,
  );
  const active = detail.data?.thread ?? threads.find((thread) => thread.id === activeId);
  const failure = feedback.error ?? detail.error;
  useEffect(() => {
    if (failure) toast.error(messageOf(failure));
  }, [failure]);
  const visible = feedback.isPlaceholderData
    ? threads
    : threads.filter((thread) => filter === 'all' || thread.status === filter);
  return (
    <>
      <PageHeading title="Feedback">
        <Button className="h-9" onClick={tryDemo}>
          <Target /> Leave feedback <ArrowUpRight />
        </Button>
      </PageHeading>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-4">
        <h2 className="text-base font-medium">
          Conversations{' '}
          <span className="ml-1 text-sm font-normal text-muted-foreground">{threads.length}</span>
        </h2>
        <div className="relative w-full sm:max-w-[220px]">
          <Search className="absolute left-2.5 top-2.5 size-3.5 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => {
              setActiveId(null);
              setSearch(event.target.value);
            }}
            placeholder="Search feedback…"
            aria-label="Search feedback"
            className="h-9 bg-card pl-8 text-xs"
          />
        </div>
      </div>
      <div role="status" className="mb-2 min-h-4 text-[11px] text-muted-foreground">
        {feedback.isFetching ? 'Updating feedback…' : null}
      </div>
      <Card
        aria-busy={feedback.isFetching}
        className="gap-0 overflow-hidden rounded-xl py-0 shadow-none"
      >
        <Tabs
          value={filter}
          onValueChange={(value) => {
            if (typeof value === 'string') {
              setActiveId(null);
              setFilter(value);
            }
          }}
        >
          <TabsList
            variant="line"
            className="h-14 w-full justify-start gap-4 border-b px-4 sm:gap-6 sm:px-6"
          >
            {[
              { id: 'all', label: 'All feedback' },
              { id: 'open', label: 'Open' },
              { id: 'resolved', label: 'Resolved' },
            ].map((tab) => (
              <TabsTrigger
                key={tab.id}
                value={tab.id}
                className="h-14 flex-none px-0 text-xs after:bottom-0"
              >
                {tab.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        {visible.length ? (
          visible.map((thread) => {
            const first = thread.messages[0];
            const job = jobs.filter((job) => job.threadId === thread.id).at(-1);
            return (
              <Button
                key={thread.id}
                variant="ghost"
                className="h-auto w-full justify-start whitespace-normal rounded-none border-b px-6 py-5 text-left font-normal last:border-b-0"
                onClick={() => {
                  setActiveId(thread.id);
                }}
              >
                <Person name={first?.author ?? ''} />
                <div className="ml-1 min-w-0 flex-1">
                  <p data-feedback-content className="line-clamp-2 break-words text-xs leading-6">
                    {first?.body}
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-2 break-all text-[10px] text-muted-foreground">
                    <span data-feedback-content className="min-w-0">
                      {first?.author}
                    </span>
                    <span>·</span>
                    <span data-feedback-content className="min-w-0">
                      {new URL(thread.context.url).pathname}
                    </span>
                    <span>·</span>
                    <span>{thread.context.anchor.tag}</span>
                    <Badge variant="secondary" className="text-[9px]">
                      {thread.status}
                    </Badge>
                    {job ? <JobBadge job={job} /> : null}
                    <UnsubmittedFeedback thread={thread} job={job} />
                  </div>
                </div>
                <div className="ml-3 hidden items-center gap-3 text-[10px] text-muted-foreground sm:flex">
                  <span>{relativeTime(thread.updatedAt)}</span>
                  <span className="flex items-center gap-1">
                    <MessageCircle className="size-3" />
                    {thread.messageCount ?? thread.messages.length}
                  </span>
                </div>
              </Button>
            );
          })
        ) : feedback.isPending ? (
          <Empty title="Loading feedback…" symbol={<Loader2 className="size-5 animate-spin" />} />
        ) : feedback.isError ? (
          <Empty title="Couldn't load feedback" description={messageOf(feedback.error)}>
            <Button variant="outline" onClick={() => void feedback.refetch()}>
              Try again
            </Button>
          </Empty>
        ) : (
          <Empty
            title={
              search
                ? 'No matching feedback'
                : filter === 'resolved'
                  ? 'No resolved feedback'
                  : 'No feedback'
            }
            description={
              search
                ? 'Try another search.'
                : filter === 'resolved'
                  ? 'Resolved feedback will appear here.'
                  : 'Select an element on the website to leave feedback.'
            }
          >
            {!search && filter !== 'resolved' ? (
              <Button variant="outline" size="sm" onClick={tryDemo}>
                Try on the example website <ExternalLink />
              </Button>
            ) : null}
          </Empty>
        )}
      </Card>
      {feedback.hasNextPage && !feedback.isPlaceholderData ? (
        <Button
          variant="outline"
          className="mt-4"
          disabled={feedback.isFetching}
          onClick={() => void feedback.fetchNextPage()}
        >
          Load earlier conversations
        </Button>
      ) : null}

      <Dialog
        open={!!active}
        onOpenChange={(open) => {
          if (!open) setActiveId(null);
        }}
      >
        <DialogContent className="flex max-h-[min(85dvh,calc(100dvh-2rem))] flex-col gap-0 overflow-hidden p-0 sm:max-w-[620px]">
          <DialogHeader className="border-b px-5 py-5">
            <DialogTitle className="text-lg">Thread</DialogTitle>
            <DialogDescription className="sr-only">
              Feedback attached to a website element, with replies and agent work.
            </DialogDescription>
          </DialogHeader>
          {active ? (
            <Conversation
              key={active.id}
              thread={active}
              job={jobs.filter((job) => job.threadId === active.id).at(-1)}
              role={p.role}
              actorId={user.id}
              onReply={async (body) => {
                await acceptThread(
                  await request(`/api/threads/${active.id}/messages`, {
                    method: 'POST',
                    body: { body },
                  }),
                );
              }}
              onReact={async (messageId, emoji) => {
                await acceptThread(
                  await request(`/api/threads/${active.id}/reactions`, {
                    method: 'POST',
                    body: { messageId, emoji },
                  }),
                );
              }}
              onSend={async () => {
                const job = await acceptJob(await requestWork(active, workKeys.current, request));
                if (job.status === 'queued') toast.success('Queued.');
                else toast.message(`Work ${job.status}.`);
              }}
              onResolve={async () => {
                await acceptThread(
                  await request(`/api/threads/${active.id}`, {
                    method: 'PATCH',
                    body: { status: active.status === 'open' ? 'resolved' : 'open' },
                  }),
                );
              }}
              onCancel={async () => {
                const job = jobs.filter((job) => job.threadId === active.id).at(-1);
                if (job)
                  await acceptJob(
                    await request(`/api/work/${job.id}/cancel`, { method: 'POST', body: {} }),
                  );
              }}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
