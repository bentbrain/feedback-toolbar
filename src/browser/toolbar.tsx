import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CSPProvider } from '@base-ui/react/csp-provider';
import { ArrowLeft, ArrowUpRight, MessageCircle, Plus, Target, X, Loader2 } from 'lucide-react';
import { z } from 'zod';
import { toast } from 'sonner';
import {
  contextSchema,
  defaultTheme,
  projectSchema,
  publicJobSchema,
  themeSchema,
  threadSchema,
} from '../shared/models.js';
import type { Theme, Thread } from '../shared/models.js';
import { createConnectionStore } from './connection-store.js';
import { applyTheme, messageOf, relativeTime, request, rootElement } from './ui.js';
import { Button } from './components/ui/button.js';
import { Badge } from './components/ui/badge.js';
import { Textarea } from './components/ui/textarea.js';
import { Label } from './components/ui/label.js';
import { TooltipProvider } from './components/ui/tooltip.js';
import { Toaster } from './components/ui/sonner.js';
import { Conversation, Empty, IconAction, JobBadge } from './components/common.js';
import type { Work } from './components/common.js';
import { deviceConnectionSchema, exchangeConnection } from '../shared/oauth.js';

const parameters = new URLSearchParams(location.search);
const projectId = parameters.get('project') ?? '';
const parentOrigin = parameters.get('origin') ?? '';
const send = (data: unknown) => {
  parent.postMessage(data, parentOrigin);
};
const publicProjectSchema = z.object({ name: z.string(), theme: themeSchema });
const themeOverridesSchema = z
  .object({
    mode: themeSchema.shape.mode.unwrap().optional(),
    accent: themeSchema.shape.accent.unwrap().optional(),
    radius: themeSchema.shape.radius.unwrap().optional(),
    density: themeSchema.shape.density.unwrap().optional(),
    placement: themeSchema.shape.placement.unwrap().optional(),
  })
  .strict();
const connectionStore = createConnectionStore(
  `feedback-embed:${projectId}:${parentOrigin}`,
  location.origin,
);
function Toolbar() {
  const [expanded, setExpanded] = useState(false);
  const [mini, setMini] = useState(false);
  const [auth, setAuth] = useState(connectionStore.read);
  const [projectName, setProjectName] = useState('Feedback');
  const [theme, setTheme] = useState<Theme>(defaultTheme);
  const [overrides, setOverrides] = useState<z.infer<typeof themeOverridesSchema>>({});
  const [page, setPage] = useState('');
  const [screen, setScreen] = useState<'list' | 'selecting' | 'compose' | 'thread'>('list');
  const [context, setContext] = useState<z.infer<typeof contextSchema> | null>(null);
  const [threads, setThreads] = useState<Thread[]>([]);
  const cachedThreads = useRef<Thread[]>([]);
  useEffect(() => {
    cachedThreads.current = threads;
  }, [threads]);
  const [activeDetail, setActiveDetail] = useState<Thread | null>(null);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const loadedPages = useRef(false);
  const [jobs, setJobs] = useState<Work[]>([]);
  const [role, setRole] = useState('viewer');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState<{
    id: string;
    clientId: string;
    code: string;
    interval: number;
    url: string;
    expires: number;
  } | null>(null);
  const version = useRef(0);
  const active =
    activeDetail?.id === activeId ? activeDetail : threads.find((thread) => thread.id === activeId);
  const resolvedTheme = useMemo(
    () => themeSchema.parse({ ...theme, ...overrides }),
    [theme, overrides],
  );
  const latestAuth = useRef(auth);
  const api = useCallback(
    async (path: string, options: { method?: string; body?: unknown } = {}) => {
      const current = await connectionStore.current();
      if (current.token !== latestAuth.current?.token) {
        latestAuth.current = current;
        setAuth(current);
      }
      return request(path, { ...options, token: current.token });
    },
    [],
  );
  const refresh = useCallback(async () => {
    if (!auth) return;
    const current = ++version.current;
    const query = new URLSearchParams({ status: 'open', ...(page ? { url: page } : {}) });
    const [list, projects, currentThread] = await Promise.all([
      api(`/api/projects/${projectId}/threads?${query.toString()}`),
      api('/api/projects'),
      activeId ? api(`/api/threads/${activeId}`) : Promise.resolve(null),
    ]);
    if (current !== version.current) return;
    const data = z
      .object({
        threads: z.array(threadSchema),
        jobs: z.array(publicJobSchema),
        nextBefore: z.number().nullable(),
      })
      .parse(list);
    const latest = currentThread
      ? z.object({ thread: threadSchema, jobs: z.array(publicJobSchema) }).parse(currentThread)
      : null;
    if (latest) {
      setActiveDetail(latest.thread);
      data.threads = data.threads.map((thread) =>
        thread.id === latest.thread.id ? latest.thread : thread,
      );
      data.jobs = [...data.jobs.filter((job) => job.threadId !== latest.thread.id), ...latest.jobs];
    }
    const ids = cachedThreads.current
      .filter(
        (thread) =>
          thread.context.url === page && !data.threads.some((fresh) => fresh.id === thread.id),
      )
      .map((thread) => thread.id);
    const batches = Array.from({ length: Math.ceil(ids.length / 50) }, (_, index) =>
      ids.slice(index * 50, index * 50 + 50),
    );
    const retained = await Promise.all(
      batches.map(async (batch) => {
        const criteria = new URLSearchParams(query);
        criteria.set('ids', batch.join(','));
        return z
          .object({ threads: z.array(threadSchema) })
          .parse(await api(`/api/projects/${projectId}/threads?${criteria.toString()}`)).threads;
      }),
    );
    if (current !== version.current) return;
    setThreads([...data.threads, ...retained.flat()]);
    if (!loadedPages.current) setNextBefore(data.nextBefore);
    setJobs(data.jobs);
    const own = z
      .object({ projects: z.array(projectSchema.extend({ role: z.string() })) })
      .parse(projects)
      .projects.find((item) => item.id === projectId);
    setRole(own?.role ?? 'viewer');
    if (own) setTheme(own.theme);
  }, [auth, api, page, activeId]);
  useEffect(() => {
    document.documentElement.classList.add('toolbar-document');
    void request(
      `/api/embed/${encodeURIComponent(projectId)}?origin=${encodeURIComponent(parentOrigin)}`,
    )
      .then((result) => {
        const info = publicProjectSchema.parse(result);
        setProjectName(info.name);
        setTheme(info.theme);
        send({ type: 'feedback:ready' });
      })
      .catch((failure: unknown) => {
        setError(messageOf(failure));
        setExpanded(true);
      });
  }, []);
  useEffect(() => {
    applyTheme(resolvedTheme);
    send({
      type: 'feedback:theme',
      accent: resolvedTheme.accent,
      placement: resolvedTheme.placement,
    });
  }, [resolvedTheme]);
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const update = () => {
      applyTheme(resolvedTheme);
    };
    media.addEventListener('change', update);
    return () => {
      media.removeEventListener('change', update);
    };
  }, [resolvedTheme]);
  useEffect(() => {
    send({
      type: 'feedback:resize',
      width: expanded ? 382 : mini ? 56 : 248,
      height: expanded ? 636 : 56,
    });
  }, [expanded, mini]);
  useEffect(() => {
    if (!auth) return;
    const fail = (failure: unknown) => {
      if (!connectionStore.read()) {
        latestAuth.current = null;
        setAuth(null);
        setThreads([]);
        setJobs([]);
      }
      setError(messageOf(failure));
    };
    void refresh().catch(fail);
    const timer = setInterval(() => void refresh().catch(fail), 5000);
    const counter = version;
    return () => {
      clearInterval(timer);
      counter.current++;
    };
  }, [auth, refresh]);
  const receive = useEffectEvent((event: MessageEvent<unknown>) => {
    const result = z
      .object({
        type: z.string(),
        theme: themeOverridesSchema.optional(),
        url: z.string().optional(),
        context: contextSchema.optional(),
        found: z.boolean().optional(),
      })
      .safeParse(event.data);
    if (!result.success) return;
    const data = result.data;
    if (data.type === 'feedback:configure') {
      version.current++;
      cachedThreads.current = [];
      setActiveDetail(null);
      setOverrides(data.theme ?? {});
      setPage(data.url ?? '');
      loadedPages.current = false;
      setNextBefore(null);
      setThreads([]);
    }
    if (data.type === 'feedback:navigation') {
      version.current++;
      cachedThreads.current = [];
      setActiveDetail(null);
      setPage(data.url ?? '');
      loadedPages.current = false;
      setNextBefore(null);
      setThreads([]);
      setScreen('list');
      setActiveId(null);
      setDraft('');
      setContext(null);
      send({ type: 'feedback:clear' });
    }
    if (data.type === 'feedback:selected' && auth && data.context) {
      setContext(data.context);
      setScreen('compose');
      setDraft('');
      setError('');
    }
    if (data.type === 'feedback:selection-cancelled') setScreen('list');
    if (data.type === 'feedback:anchor-status' && data.found === false)
      setError('This element moved or is ambiguous. The original context is still attached.');
  });
  useEffect(() => {
    const handler = (event: MessageEvent<unknown>) => {
      if (event.origin !== parentOrigin || event.source !== parent) return;
      receive(event);
    };
    window.addEventListener('message', handler);
    return () => {
      window.removeEventListener('message', handler);
    };
  }, []);
  useEffect(() => {
    if (!pending) return;
    const state = { cancelled: false, checking: false };
    let pollingInterval = pending.interval;
    const isCancelled = () => state.cancelled;
    const check = async () => {
      if (state.checking || state.cancelled) return;
      state.checking = true;
      try {
        if (pending.expires < Date.now()) throw new Error('Sign-in request expired. Try again.');
        const result = await exchangeConnection(location.origin, pending.clientId, {
          deviceCode: pending.id,
        });
        if (result.pending) {
          if (result.slowDown) pollingInterval += 5;
          return;
        }
        if (result.connection && !isCancelled()) {
          connectionStore.start(result.connection);
          latestAuth.current = result.connection;
          setAuth(result.connection);
          setPending(null);
          setError('');
        }
      } catch (failure) {
        if (!isCancelled()) {
          setError(messageOf(failure));
          setPending(null);
        }
      } finally {
        state.checking = false;
      }
    };
    let lastCheck = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - lastCheck >= pollingInterval * 1000) {
        lastCheck = Date.now();
        void check();
      }
    }, 1000);
    return () => {
      state.cancelled = true;
      clearInterval(timer);
    };
  }, [pending]);
  const signIn = async () => {
    const popup = window.open('about:blank', 'feedback-signin', 'popup,width=520,height=700');
    try {
      let info = pending;
      if (!info) {
        const grant = deviceConnectionSchema.parse(
          await request('/api/connections/start', {
            method: 'POST',
            body: { kind: 'embed', projectId, parentOrigin },
          }),
        );
        const destination = new URL(grant.verification_uri_complete);
        if (destination.origin !== location.origin || destination.pathname !== '/auth')
          throw new Error('Invalid approval URL.');
        info = {
          id: grant.device_code,
          clientId: grant.clientId,
          code: grant.user_code,
          interval: grant.interval,
          url: destination.href,
          expires: Date.now() + grant.expires_in * 1000,
        };
        setPending(info);
      }
      if (popup) popup.location.href = info.url;
      else setError('Allow popups, then click Sign in again.');
    } catch (failure) {
      popup?.close();
      setError(messageOf(failure));
    }
  };
  const select = () => {
    setExpanded(true);
    setError('');
    if (!auth) return;
    if (role === 'viewer') {
      setError('You have view-only access to this project.');
      return;
    }
    setScreen('selecting');
    send({ type: 'feedback:select' });
  };
  const back = () => {
    setScreen('list');
    setActiveId(null);
    setActiveDetail(null);
    setDraft('');
    setError('');
    send({ type: 'feedback:clear' });
  };
  const collapse = () => {
    setExpanded(false);
    back();
  };
  const signOut = async () => {
    version.current++;
    cachedThreads.current = [];
    try {
      await connectionStore.signOut();
    } finally {
      latestAuth.current = null;
      setAuth(null);
      setThreads([]);
      loadedPages.current = false;
      setNextBefore(null);
      setJobs([]);
      back();
    }
  };
  const pageThreads = threads.filter(
    (thread) => thread.context.url === page && thread.status === 'open',
  );
  const sendWork = async (thread: Thread) => {
    await api(`/api/threads/${thread.id}/work`, {
      method: 'POST',
      body: { revision: thread.revision, idempotencyKey: crypto.randomUUID() },
    });
    await refresh();
    toast.success('Queued.');
  };
  return (
    <TooltipProvider>
      <Toaster position="top-center" theme={resolvedTheme.mode === 'dark' ? 'dark' : 'light'} />
      {!expanded ? (
        <div className="m-1 flex h-12 items-center justify-between rounded-lg border bg-card px-2 shadow-sm">
          {mini ? (
            <IconAction
              label="Open feedback"
              onClick={() => {
                setMini(false);
                setExpanded(true);
              }}
            >
              <MessageCircle className="size-4 text-primary" />
            </IconAction>
          ) : (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setExpanded(true);
                }}
                className="gap-2 text-xs"
              >
                <MessageCircle className="size-4 text-primary" />
                Feedback
                <Badge variant="secondary" className="px-1.5 text-[9px]">
                  {pageThreads.length}
                </Badge>
              </Button>
              <span className="h-4 border-l" />
              <IconAction label="Select an element" onClick={select}>
                <Target className="size-4" />
              </IconAction>
              <IconAction
                label="Minimize to icon"
                onClick={() => {
                  setMini(true);
                }}
              >
                <X className="size-3" />
              </IconAction>
            </>
          )}
        </div>
      ) : (
        <section className="m-1 flex h-[calc(100vh-8px)] max-h-[628px] flex-col overflow-hidden rounded-lg border bg-card shadow-sm">
          <header className="flex items-center justify-between border-b px-5 py-4">
            <div className="flex items-center gap-2">
              {['thread', 'compose'].includes(screen) ? (
                <IconAction label="Back to feedback" onClick={back}>
                  <ArrowLeft className="size-4" />
                </IconAction>
              ) : (
                <MessageCircle className="size-4 text-primary" />
              )}
              <div className="text-sm font-medium">
                Feedback
                <p className="mt-0.5 text-[10px] font-normal text-muted-foreground">
                  {projectName}
                </p>
              </div>
            </div>
            <IconAction label="Minimize toolbar" onClick={collapse}>
              <X className="size-4" />
            </IconAction>
          </header>
          {error ? (
            <p
              role="alert"
              className="mx-4 mt-3 rounded-lg border bg-muted/40 p-3 text-[11px] leading-5 text-destructive"
            >
              {error}
            </p>
          ) : null}
          {!auth ? (
            <div className="flex-1 overflow-auto">
              <Empty title="Sign in">
                <Button onClick={() => void signIn()} size="sm">
                  Sign in to Feedback <ArrowUpRight />
                </Button>
                {pending ? (
                  <p className="text-[10px] text-muted-foreground">
                    Approval code: {pending.code}. Confirm this code in the sign-in window.
                  </p>
                ) : null}
              </Empty>
            </div>
          ) : screen === 'selecting' ? (
            <div className="flex-1">
              <Empty
                title="Select an element"
                description="Click an element on the page. Press Escape to cancel."
                symbol={<Target className="size-5" />}
              >
                <Button variant="outline" size="sm" onClick={back}>
                  Cancel selection
                </Button>
              </Empty>
            </div>
          ) : screen === 'compose' && context ? (
            <div className="flex-1 overflow-auto p-5">
              <div className="mb-5 rounded-lg border bg-muted/40 p-3">
                <code className="break-all text-[10px] text-primary">
                  {context.anchor.selector}
                </code>
                <p className="mt-2 line-clamp-3 text-[11px] leading-5 text-muted-foreground">
                  {context.anchor.text || context.anchor.tag}
                </p>
              </div>
              <form
                className="grid gap-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  setBusy(true);
                  void api(`/api/projects/${projectId}/threads`, {
                    method: 'POST',
                    body: { context, body: draft },
                  })
                    .then(async (result) => {
                      const thread = z.object({ thread: threadSchema }).parse(result).thread;
                      setActiveId(thread.id);
                      setScreen('thread');
                      setDraft('');
                      await refresh();
                    })
                    .catch((failure: unknown) => {
                      setError(messageOf(failure));
                    })
                    .finally(() => {
                      setBusy(false);
                    });
                }}
              >
                <Label htmlFor="comment" className="text-xs">
                  What would you like to change?
                </Label>
                <Textarea
                  id="comment"
                  value={draft}
                  onChange={(event) => {
                    setDraft(event.target.value);
                  }}
                  placeholder="Describe the change…"
                  maxLength={8000}
                  required
                  className="min-h-32 text-xs leading-6"
                  autoFocus
                />
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[10px] text-muted-foreground">
                    Visible to project members
                  </span>
                  <Button type="submit" disabled={busy || !draft.trim()} size="sm">
                    {busy ? <Loader2 className="animate-spin" /> : null}Post feedback{' '}
                    <ArrowUpRight />
                  </Button>
                </div>
              </form>
            </div>
          ) : screen === 'thread' && active ? (
            <Conversation
              key={active.id}
              compact
              thread={active}
              job={jobs.filter((job) => job.threadId === active.id).at(-1)}
              role={role}
              onReply={async (body) => {
                await api(`/api/threads/${active.id}/messages`, { method: 'POST', body: { body } });
                await refresh();
              }}
              onReact={async (messageId, emoji) => {
                await api(`/api/threads/${active.id}/reactions`, {
                  method: 'POST',
                  body: { messageId, emoji },
                });
                await refresh();
              }}
              onSend={() => sendWork(active)}
              onResolve={async () => {
                await api(`/api/threads/${active.id}`, {
                  method: 'PATCH',
                  body: { status: active.status === 'open' ? 'resolved' : 'open' },
                });
                await refresh();
              }}
              onHighlight={() => {
                send({ type: 'feedback:highlight', selector: active.context.anchor.selector });
              }}
              onCancel={async () => {
                const job = jobs.filter((job) => job.threadId === active.id).at(-1);
                if (job) {
                  await api(`/api/work/${job.id}/cancel`, { method: 'POST', body: {} });
                  await refresh();
                }
              }}
            />
          ) : (
            <>
              <div className="flex items-center justify-between border-b px-5 py-3">
                <span className="eyebrow text-[9px]">On this page</span>
                {role !== 'viewer' ? (
                  <Button variant="outline" size="xs" onClick={select}>
                    <Plus className="size-3" />
                    New feedback
                  </Button>
                ) : null}
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto">
                {pageThreads.length ? (
                  pageThreads.map((thread) => {
                    const job = jobs.filter((job) => job.threadId === thread.id).at(-1);
                    return (
                      <Button
                        key={thread.id}
                        variant="ghost"
                        className="h-auto w-full flex-col items-start gap-2 whitespace-normal rounded-none border-b px-5 py-4 text-left font-normal last:border-b-0"
                        onClick={() => {
                          setActiveId(thread.id);
                          setScreen('thread');
                          setError('');
                        }}
                      >
                        <span data-feedback-content className="line-clamp-2 text-xs leading-6">
                          {thread.messages[0]?.body}
                        </span>
                        <span className="flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
                          <span data-feedback-content>{thread.messages[0]?.author}</span>
                          <span>·</span>
                          {relativeTime(thread.updatedAt)}
                          <Badge variant="secondary" className="text-[9px]">
                            {thread.messageCount ?? thread.messages.length} messages
                          </Badge>
                          {job ? <JobBadge job={job} /> : null}
                        </span>
                      </Button>
                    );
                  })
                ) : (
                  <Empty
                    title="No feedback"
                    description="Select an element to leave feedback."
                    symbol={<Target className="size-5" />}
                  >
                    {role !== 'viewer' ? (
                      <Button size="sm" onClick={select}>
                        <Plus />
                        Leave feedback
                      </Button>
                    ) : (
                      <p className="text-xs text-muted-foreground">You have view-only access.</p>
                    )}
                  </Empty>
                )}
                {nextBefore ? (
                  <Button
                    variant="ghost"
                    className="m-4"
                    size="sm"
                    onClick={() => {
                      const current = ++version.current;
                      void api(
                        `/api/projects/${projectId}/threads?status=open&before=${nextBefore}${page ? `&url=${encodeURIComponent(page)}` : ''}`,
                      )
                        .then((result) => {
                          if (current !== version.current) return;
                          const page = z
                            .object({
                              threads: z.array(threadSchema),
                              nextBefore: z.number().nullable(),
                            })
                            .parse(result);
                          loadedPages.current = true;
                          setNextBefore(page.nextBefore);
                          setThreads((previous) => [
                            ...previous,
                            ...page.threads.filter(
                              (thread) => !previous.some((current) => current.id === thread.id),
                            ),
                          ]);
                        })
                        .catch((failure: unknown) => {
                          setError(messageOf(failure));
                        });
                    }}
                  >
                    Load earlier feedback
                  </Button>
                ) : null}
              </div>
            </>
          )}
          <footer className="flex shrink-0 items-center justify-between border-t px-5 py-3 text-[10px] text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <span className="size-1.5 rounded-full bg-primary" />
              {auth?.user?.name ?? ''}
            </span>
            {auth ? (
              <Button
                variant="ghost"
                size="xs"
                className="h-5 text-[10px]"
                onClick={() =>
                  void signOut().catch((failure: unknown) => {
                    setError(messageOf(failure));
                  })
                }
              >
                Sign out
              </Button>
            ) : null}
          </footer>
        </section>
      )}
    </TooltipProvider>
  );
}
const nonce = document.querySelector('meta[name=csp-nonce]')?.getAttribute('content') ?? undefined;
createRoot(rootElement()).render(
  <CSPProvider nonce={nonce}>
    <Toolbar />
  </CSPProvider>,
);
