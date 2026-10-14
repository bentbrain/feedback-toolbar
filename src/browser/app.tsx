import { useCallback, useEffect, useRef, useState } from 'react';
import type { SubmitEvent, ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { CSPProvider } from '@base-ui/react/csp-provider';
import {
  ArrowUpRight,
  Bot,
  Check,
  Code2,
  ExternalLink,
  LogOut,
  MessageCircle,
  Palette,
  Plus,
  Search,
  Target,
  Users,
  X,
  Loader2,
  Sun,
  Moon,
  Monitor,
  ShieldCheck,
} from 'lucide-react';
import { z } from 'zod';
import type { LucideIcon } from 'lucide-react';
import { toast } from 'sonner';
import {
  defaultTheme,
  installation,
  memberSchema,
  projectSchema,
  publicJobSchema,
  publicUserSchema,
  themeSchema,
  threadSchema,
} from '../shared/models.js';
import type { Project, Theme, Thread } from '../shared/models.js';
import { applyTheme, formInput, messageOf, relativeTime, request, rootElement } from './ui.js';
import { cn } from './lib/utils.js';
import { Button } from './components/ui/button.js';
import { Input } from './components/ui/input.js';
import { Textarea } from './components/ui/textarea.js';
import { Label } from './components/ui/label.js';
import { Badge } from './components/ui/badge.js';
import { Card } from './components/ui/card.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from './components/ui/dialog.js';
import { Tabs, TabsList, TabsTrigger } from './components/ui/tabs.js';
import { TooltipProvider } from './components/ui/tooltip.js';
import { Toaster } from './components/ui/sonner.js';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from './components/ui/dropdown-menu.js';
import {
  Brand,
  Choice,
  Code,
  Conversation,
  Empty,
  JobBadge,
  PageHeading,
  Person,
  Section,
} from './components/common.js';
import type { Work } from './components/common.js';

const projectListSchema = z.array(projectSchema.extend({ role: z.string() }));
const memberListSchema = z.array(memberSchema.extend({ user: publicUserSchema }));
const agentListSchema = z.array(
  z.object({ id: z.string(), name: z.string(), expiresAt: z.number(), createdAt: z.string() }),
);
type Account = z.infer<typeof publicUserSchema>;
type ProjectWithRole = z.infer<typeof projectListSchema>[number];
type View = 'feedback' | 'install' | 'appearance' | 'people' | 'agents' | 'account';
const navigation: { id: View; label: string; icon: LucideIcon }[] = [
  { id: 'feedback', label: 'Feedback', icon: MessageCircle },
  { id: 'install', label: 'Installation', icon: Code2 },
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'people', label: 'People', icon: Users },
  { id: 'agents', label: 'Agents', icon: Bot },
  { id: 'account', label: 'Account security', icon: ShieldCheck },
];
const grant = new URLSearchParams(location.search).get('user_code');

function Field({
  label,
  id,
  children,
  hint,
}: {
  label: string;
  id: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={id} className="text-xs text-secondary-foreground">
        {label}
      </Label>
      {children}
      {hint ? <p className="text-[11px] leading-5 text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
function Auth({
  onSignIn,
  allowSignup,
  github,
  localPassword,
}: {
  onSignIn: (user: Account) => void;
  allowSignup: boolean;
  github: boolean;
  localPassword: boolean;
}) {
  const [signup, setSignup] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(
    new URLSearchParams(location.search).has('error')
      ? 'GitHub sign-in could not complete. Try again or contact the service owner.'
      : '',
  );
  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setBusy(true);
    setError('');
    try {
      const input = {
        email: formInput(form, 'email'),
        password: formInput(form, 'password'),
        ...(signup ? { name: formInput(form, 'name') } : {}),
      };
      const result = z.object({ user: publicUserSchema }).parse(
        await request(`/api/auth/${signup ? 'sign-up/email' : 'sign-in/email'}`, {
          method: 'POST',
          body: input,
        }),
      );
      onSignIn(result.user);
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex min-h-screen items-center justify-center px-6 py-12">
      <section className="w-full max-w-[360px]">
        <Brand />
        <form onSubmit={(event) => void submit(event)} className="mt-8 grid gap-6">
          <div>
            <h2 className="text-[28px] font-medium tracking-[-.8px]">
              {signup ? 'Create account' : 'Sign in'}
            </h2>
          </div>
          {github ? (
            <Button
              type="button"
              className="h-10"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void request('/api/auth/sign-in/social', {
                  method: 'POST',
                  body: { provider: 'github', callbackURL: location.href },
                })
                  .then((data) => {
                    const response = z.object({ url: z.url() }).parse(data);
                    const destination = new URL(response.url);
                    if (destination.origin !== 'https://github.com')
                      throw new Error('Invalid GitHub sign-in URL.');
                    location.assign(destination.href);
                  })
                  .catch((failure: unknown) => {
                    setError(messageOf(failure));
                    setBusy(false);
                  });
              }}
            >
              Continue with GitHub <ArrowUpRight />
            </Button>
          ) : null}
          {localPassword ? (
            <div className="grid gap-5">
              {signup ? (
                <Field label="Name" id="name">
                  <Input
                    id="name"
                    name="name"
                    placeholder="Alex Morgan"
                    autoComplete="name"
                    maxLength={60}
                    required
                    className="h-10"
                  />
                </Field>
              ) : null}
              <Field label="Email address" id="email">
                <Input
                  id="email"
                  name="email"
                  type="email"
                  placeholder="you@example.com"
                  autoComplete="email"
                  required
                  className="h-10"
                />
              </Field>
              <Field label="Password" id="password" hint="At least 12 characters.">
                <Input
                  id="password"
                  name="password"
                  type="password"
                  placeholder="Password"
                  autoComplete={signup ? 'new-password' : 'current-password'}
                  minLength={12}
                  maxLength={200}
                  required
                  className="h-10"
                />
              </Field>
              {error ? (
                <p role="alert" className="text-xs leading-5 text-destructive">
                  {error}
                </p>
              ) : null}
              <Button type="submit" className="h-10" disabled={busy}>
                {busy ? <Loader2 className="animate-spin" /> : null}
                {signup ? 'Create account' : 'Sign in'}
                <ArrowUpRight />
              </Button>
            </div>
          ) : error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
          {allowSignup ? (
            <div className="text-center text-xs text-muted-foreground">
              <Button
                variant="link"
                size="xs"
                type="button"
                onClick={() => {
                  setSignup(!signup);
                  setError('');
                }}
              >
                {signup ? 'Sign in' : 'Create an account'}
              </Button>
            </div>
          ) : null}
        </form>
      </section>
    </div>
  );
}
function Consent({ user, onLogout }: { user: Account; onLogout: () => void }) {
  const [info, setInfo] = useState<z.infer<typeof consentSchema> | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      setInfo(
        consentSchema.parse(
          await request(`/api/connections/approval?code=${encodeURIComponent(grant ?? '')}`),
        ),
      );
    } catch (failure) {
      setError(messageOf(failure));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-8 px-6">
      <Brand />
      <Card className="w-full max-w-md p-7">
        <div className="grid gap-5">
          <p className="eyebrow">Signed in as {user.name}</p>
          <h1 className="text-2xl font-medium tracking-tight">
            {info?.denied
              ? 'Connection denied.'
              : info?.authorized
                ? 'Connection approved.'
                : info?.kind === 'embed'
                  ? 'Connect this toolbar?'
                  : 'Connect local tools?'}
          </h1>
          {error ? (
            <p className="text-xs text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          <p className="text-xs leading-6 text-muted-foreground">
            {info?.denied
              ? 'Close this window.'
              : info?.authorized
                ? 'Close this window.'
                : info?.kind === 'embed'
                  ? `${info.projectName} on ${info.parentOrigin}`
                  : 'Allow CLI and MCP tools to use your account permissions.'}
          </p>
          <p className="text-xs font-medium">Approval code: {grant}</p>
          <p className="text-xs text-muted-foreground">
            Only approve this code if it matches the code in your toolbar or terminal.
          </p>
          <div className="grid gap-3 rounded-lg border bg-muted/40 p-4 text-xs text-secondary-foreground">
            <span className="flex gap-2">
              <Check className="size-3.5" />
              {info?.kind === 'embed'
                ? 'Participate in this project'
                : 'Create and manage projects'}
            </span>
            <span className="flex gap-2">
              <Check className="size-3.5" />
              {info?.kind === 'embed'
                ? 'Request agent work if you are an owner'
                : 'Read feedback and connect project-scoped agents'}
            </span>
          </div>
          {info && !info.authorized && !info.denied ? (
            <Button
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void request('/api/connections/approve', {
                  method: 'POST',
                  body: { code: grant, accept: true },
                })
                  .then(load)
                  .catch((failure: unknown) => {
                    setError(messageOf(failure));
                  })
                  .finally(() => {
                    setBusy(false);
                  });
              }}
            >
              Approve connection <ArrowUpRight />
            </Button>
          ) : null}
          <Button
            variant="outline"
            disabled={busy || !info || info.authorized || info.denied}
            onClick={() => {
              setBusy(true);
              void request('/api/connections/approve', {
                method: 'POST',
                body: { code: grant, accept: false },
              })
                .then(() => {
                  setInfo((current) =>
                    current ? { ...current, denied: true, authorized: false } : null,
                  );
                })
                .catch((failure: unknown) => {
                  setError(messageOf(failure));
                })
                .finally(() => {
                  setBusy(false);
                });
            }}
          >
            Deny connection
          </Button>
          <Button variant="ghost" onClick={onLogout}>
            Use another account
          </Button>
        </div>
      </Card>
    </div>
  );
}
const consentSchema = z.object({
  kind: z.enum(['embed', 'personal']),
  projectName: z.string().nullable(),
  parentOrigin: z.string().nullable(),
  authorized: z.boolean(),
  denied: z.boolean(),
});

const accountConnectionsSchema = z.object({
  connections: z.array(
    z.object({
      clientId: z.string(),
      name: z.string().nullable(),
      kind: z.enum(['embed', 'personal']),
      parentOrigin: z.string().nullable(),
    }),
  ),
});

function AccountSecurity() {
  const [connections, setConnections] = useState<
    z.infer<typeof accountConnectionsSchema>['connections']
  >([]);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const load = useCallback(async () => {
    const data = accountConnectionsSchema.parse(await request('/api/account/connections'));
    setConnections(data.connections);
    setReady(true);
  }, []);
  useEffect(() => {
    void load().catch((failure: unknown) => toast.error(messageOf(failure)));
  }, [load]);
  const revoke = async (clientId?: string) => {
    setBusy(true);
    try {
      await request(clientId ? `/api/account/connections/${clientId}` : '/api/account/revoke-all', {
        method: clientId ? 'DELETE' : 'POST',
        body: {},
      });
      await load();
      toast.success(
        clientId
          ? 'Connection revoked.'
          : 'Other sessions, toolbar connections, local tools and agent keys revoked.',
      );
    } catch (failure) {
      toast.error(messageOf(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <PageHeading title="Account security" />
      <Section title="Connected tools and websites">
        {!ready ? (
          <p className="text-xs text-muted-foreground">Loading connections…</p>
        ) : !connections.length ? (
          <p className="text-xs text-muted-foreground">No connected tools or websites.</p>
        ) : (
          connections.map((connection) => (
            <div
              className="flex items-center justify-between gap-4 border-b py-4 last:border-b-0"
              key={connection.clientId}
            >
              <div>
                <p className="text-sm">
                  {connection.kind === 'embed' ? 'Website toolbar' : 'Local CLI / MCP'}
                </p>
                <p className="mt-1 break-all text-xs text-muted-foreground">
                  {connection.parentOrigin ?? 'Account access'}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => void revoke(connection.clientId)}
              >
                Disconnect
              </Button>
            </div>
          ))
        )}
      </Section>
      <Section title="Recover a lost device">
        <p className="mb-4 text-xs leading-6 text-muted-foreground">
          Revokes tool connections, agent keys and other browser sessions. This browser stays signed
          in.
        </p>
        <Button variant="destructive" disabled={busy} onClick={() => void revoke()}>
          Revoke other access
        </Button>
      </Section>
    </>
  );
}

function NewProject({
  open,
  onOpenChange,
  onCreated,
  demoUrl,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (project: Project) => Promise<void>;
  demoUrl: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const key = useRef(crypto.randomUUID());
  const submit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    setBusy(true);
    setError('');
    try {
      const data = z.object({ project: projectSchema }).parse(
        await request('/api/projects', {
          method: 'POST',
          body: {
            name: formInput(form, 'name'),
            origins: formInput(form, 'origins')
              .split('\n')
              .map((value) => value.trim())
              .filter(Boolean),
          },
          headers: { 'Idempotency-Key': key.current },
        }),
      );
      await onCreated(data.project);
      key.current = crypto.randomUUID();
      onOpenChange(false);
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-6 p-6 sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle className="mt-2 text-2xl tracking-tight">New project</DialogTitle>
          <DialogDescription className="text-xs leading-6">
            Choose a name and allowed website origins.
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-5" onSubmit={(event) => void submit(event)}>
          <Field label="Project name" id="project-name">
            <Input
              id="project-name"
              name="name"
              placeholder="My website"
              maxLength={80}
              required
              className="h-10"
            />
          </Field>
          <Field
            label="Website origins"
            id="project-origins"
            hint="One HTTPS origin per line. The example origin is prefilled."
          >
            <Textarea
              id="project-origins"
              name="origins"
              defaultValue={new URL(demoUrl).origin}
              placeholder="https://your-website.com"
              required
              className="min-h-24 text-xs leading-6"
            />
          </Field>
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
          <Button type="submit" disabled={busy} className="h-10">
            Create project <ArrowUpRight />
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
function Installation({
  project,
  onSave,
  onDemo,
}: {
  project: ProjectWithRole;
  onSave: (input: unknown) => Promise<void>;
  onDemo: () => void;
}) {
  const [origins, setOrigins] = useState(project.origins.join('\n'));
  const [busy, setBusy] = useState(false);
  const info = installation(project, location.origin);
  return (
    <>
      <PageHeading title="Installation" />
      <div className="grid items-start gap-6 xl:grid-cols-2">
        <Section title="Install the toolbar">
          <div className="grid gap-7">
            <Step number="1" title="Add this to your shared HTML layout">
              <Code>{info.snippet}</Code>
            </Step>
            <Step number="2" title="Or ask your agent to do it">
              <Code>{`feedback-toolbar login --server ${location.origin}\nfeedback-toolbar init --server ${location.origin} --project ${project.id} --file ./index.html --json`}</Code>
            </Step>
            <Step number="3" title="Open your website">
              <div className="flex flex-wrap gap-2">
                {project.origins.map((origin) => (
                  <Button
                    key={origin}
                    variant="outline"
                    size="sm"
                    nativeButton={false}
                    render={
                      <a
                        href={`${origin}/#feedback-connect`}
                        target="_blank"
                        rel="noopener noreferrer"
                      />
                    }
                  >
                    {new URL(origin).host} <ArrowUpRight />
                  </Button>
                ))}
              </div>
              <Button variant="outline" size="sm" onClick={onDemo}>
                Try on the example website <ArrowUpRight />
              </Button>
            </Step>
          </div>
        </Section>
        <div className="grid gap-6">
          <Section
            title="Allowed websites"
            description="Exact origins that can embed this project's toolbar."
          >
            <form
              className="grid gap-5"
              onSubmit={(event) => {
                event.preventDefault();
                setBusy(true);
                void onSave({
                  origins: origins
                    .split('\n')
                    .map((value) => value.trim())
                    .filter(Boolean),
                })
                  .then(() => toast.success('Allowed websites updated.'))
                  .catch((failure: unknown) => toast.error(messageOf(failure)))
                  .finally(() => {
                    setBusy(false);
                  });
              }}
            >
              <Field
                label="Website origins"
                id="origins"
                hint="Include production, preview, and local origins. Public websites require HTTPS."
              >
                <Textarea
                  id="origins"
                  value={origins}
                  onChange={(event) => {
                    setOrigins(event.target.value);
                  }}
                  className="min-h-28 text-xs leading-6"
                  disabled={project.role !== 'owner'}
                />
              </Field>
              {project.role === 'owner' ? (
                <Button type="submit" disabled={busy}>
                  Save websites
                </Button>
              ) : null}
            </form>
          </Section>
          <Section title="JavaScript module">
            <p className="mb-4 text-xs leading-6 text-muted-foreground">
              Mount once; call destroy on cleanup.
            </p>
            <Code>{`${info.module}\n\n// On unmount:\ntoolbar.destroy();`}</Code>
            <p className="mt-4 text-[11px] leading-6 text-muted-foreground">
              For strict CSP sites, allow {location.origin} in script-src and frame-src.
              Authentication stays inside the toolbar.
            </p>
          </Section>
        </div>
      </div>
    </>
  );
}
function Step({ number, title, children }: { number: string; title: string; children: ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full border bg-muted/40 text-[10px] text-secondary-foreground">
        {number}
      </span>
      <div className="grid min-w-0 gap-3 text-xs text-muted-foreground [&>p]:leading-6">
        <h3 className="font-medium text-foreground">{title}</h3>
        {children}
      </div>
    </div>
  );
}
function ToolbarPreview({ theme, name }: { theme: Theme; name: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) applyTheme(theme, ref.current);
  }, [theme]);
  return (
    <div ref={ref} className="w-full max-w-[340px]">
      <Card className="gap-0 overflow-hidden rounded-lg py-0 shadow-lg shadow-black/5">
        <div className="flex items-center justify-between border-b px-5 py-4">
          <div className="flex items-center gap-2">
            <MessageCircle className="size-4 text-primary" />
            <div className="text-sm font-medium">
              Feedback<p className="mt-0.5 text-[10px] font-normal text-muted-foreground">{name}</p>
            </div>
          </div>
          <Button variant="ghost" size="icon-xs" aria-label="Example close button">
            <X className="size-3" />
          </Button>
        </div>
        <div className="p-5">
          <div className="mb-4 rounded-lg border bg-muted/40 p-3">
            <code className="text-[10px] text-primary">[data-feedback-id="hero-button"]</code>
            <p className="mt-1 text-[11px] text-muted-foreground">Get started</p>
          </div>
          <div className="mb-5 flex gap-2">
            <Person name="Alex Morgan" small />
            <div>
              <strong className="text-[11px] font-medium">Alex Morgan</strong>
              <span className="ml-2 text-[9px] text-muted-foreground">Just now</span>
              <p className="mt-2 text-xs leading-6">
                Could we give this button a little more space?
              </p>
              <div className="mt-2 flex gap-1">
                <Button variant="outline" size="xs">
                  👍 2
                </Button>
                <Button variant="outline" size="xs">
                  👀
                </Button>
              </div>
            </div>
          </div>
          <div className="flex items-center justify-between gap-3">
            <Button size="sm">
              <Bot /> Send to agent
            </Button>
          </div>
        </div>
        <div className="flex justify-between border-t px-5 py-3 text-[9px] text-muted-foreground">
          <span>● Alex Morgan</span>
        </div>
      </Card>
    </div>
  );
}
function Appearance({
  project,
  onSave,
}: {
  project: ProjectWithRole;
  onSave: (input: unknown) => Promise<void>;
}) {
  const [draft, setDraft] = useState(project.theme);
  const [busy, setBusy] = useState(false);
  const saved = JSON.stringify(draft) === JSON.stringify(project.theme);
  const change = (patch: Partial<Theme>) => {
    setDraft((previous) => themeSchema.parse({ ...previous, ...patch }));
  };
  return (
    <>
      <PageHeading title="Appearance" />
      <div className="grid items-start gap-6 xl:grid-cols-2">
        <Section title="Toolbar theme">
          <div className="grid gap-6">
            <div className="grid gap-3">
              <Label className="text-xs">Color mode</Label>
              <Tabs
                value={draft.mode}
                onValueChange={(value) => {
                  change({ mode: themeSchema.shape.mode.parse(value) });
                }}
              >
                <TabsList className="h-16 w-full gap-2 bg-transparent p-0">
                  {[
                    { id: 'light', icon: Sun },
                    { id: 'dark', icon: Moon },
                    { id: 'system', icon: Monitor },
                  ].map(({ id, icon: Icon }) => (
                    <TabsTrigger
                      key={id}
                      value={id}
                      className="flex h-full flex-col gap-2 rounded-lg border px-5 text-xs capitalize data-active:border-secondary-foreground/60 data-active:bg-secondary/30"
                    >
                      <Icon className="size-4" />
                      {id}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
            </div>
            <div className="grid gap-3">
              <Label htmlFor="accent" className="text-xs">
                Accent color
              </Label>
              <div className="flex flex-wrap gap-3">
                {['#0647ff', '#72865d', '#6f7ee6', '#b46c97', '#2b8293', '#292f29'].map((color) => (
                  <Button
                    key={color}
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Use ${color}`}
                    className={cn(
                      'size-7 rounded-full border-[3px] border-card p-0 ring-1 ring-border',
                      draft.accent === color && 'ring-2 ring-secondary-foreground',
                    )}
                    style={{ backgroundColor: color }}
                    onClick={() => {
                      change({ accent: color });
                    }}
                  />
                ))}
              </div>
              <div className="flex gap-2">
                <Input
                  id="accent"
                  type="color"
                  className="size-9 shrink-0 p-1"
                  value={draft.accent}
                  onChange={(event) => {
                    change({ accent: event.target.value });
                  }}
                />
                <Input
                  key={draft.accent}
                  aria-label="Accent hex value"
                  defaultValue={draft.accent}
                  maxLength={7}
                  className="h-9 font-mono text-xs"
                  onBlur={(event) => {
                    const next = themeSchema.shape.accent.safeParse(event.target.value);
                    if (next.success) change({ accent: next.data });
                    else toast.error('Use a six-digit hex color.');
                  }}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <Choice
                label="Corners"
                value={draft.radius}
                options={['square', 'soft', 'round'].map((value) => ({
                  value,
                  label: value.slice(0, 1).toUpperCase() + value.slice(1),
                }))}
                onChange={(value) => {
                  change({ radius: themeSchema.shape.radius.parse(value) });
                }}
              />
              <Choice
                label="Spacing"
                value={draft.density}
                options={['comfortable', 'compact'].map((value) => ({
                  value,
                  label: value.slice(0, 1).toUpperCase() + value.slice(1),
                }))}
                onChange={(value) => {
                  change({ density: themeSchema.shape.density.parse(value) });
                }}
              />
            </div>
            <Choice
              label="Position on the website"
              value={draft.placement}
              options={[
                { value: 'bottom-right', label: 'Bottom right' },
                { value: 'bottom-left', label: 'Bottom left' },
              ]}
              onChange={(value) => {
                change({ placement: themeSchema.shape.placement.parse(value) });
              }}
            />
            <div className="flex flex-wrap items-center gap-3">
              {project.role === 'owner' ? (
                <>
                  <Button
                    disabled={busy || saved}
                    onClick={() => {
                      setBusy(true);
                      void onSave({ theme: draft })
                        .then(() => toast.success('Theme saved.'))
                        .catch((failure: unknown) => toast.error(messageOf(failure)))
                        .finally(() => {
                          setBusy(false);
                        });
                    }}
                  >
                    Save appearance
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => {
                      setDraft(defaultTheme);
                    }}
                  >
                    Reset defaults
                  </Button>
                </>
              ) : (
                <p className="text-xs text-muted-foreground">Only owners can save the theme.</p>
              )}
              <span className="text-[10px] text-muted-foreground">
                {saved ? 'All changes saved' : 'Unsaved changes'}
              </span>
            </div>
          </div>
        </Section>
        <div>
          <Card className="gap-0 overflow-hidden rounded-xl py-0 shadow-none">
            <div className="flex items-center justify-between border-b px-6 py-5">
              <h3 className="text-sm font-medium">Live preview</h3>
            </div>
            <div className="preview-dots flex min-h-[380px] items-center justify-center bg-muted/50 p-6">
              <ToolbarPreview theme={draft} name={project.name} />
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
function People({
  project,
  members,
  onReload,
}: {
  project: ProjectWithRole;
  members: z.infer<typeof memberListSchema>;
  onReload: () => Promise<void>;
}) {
  const [role, setRole] = useState('member');
  const [busy, setBusy] = useState(false);
  return (
    <>
      <PageHeading title="Members" />
      <div className="grid items-start gap-6 xl:grid-cols-2">
        <Section title="Project members">
          <div className="-m-6">
            {members.map((member) => (
              <div
                key={member.id}
                className="flex items-center gap-3 border-b px-6 py-5 last:border-0"
              >
                <Person name={member.user.name} />
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium">{member.user.name}</p>
                  <p className="mt-1 truncate text-[11px] text-muted-foreground">
                    {member.user.email}
                  </p>
                </div>
                <Badge variant="secondary" className="text-[10px] capitalize">
                  {member.role}
                </Badge>
                {project.role === 'owner' && member.role !== 'owner' ? (
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Remove ${member.user.name}`}
                    onClick={() =>
                      void request(`/api/projects/${project.id}/members/${member.userId}`, {
                        method: 'DELETE',
                        body: {},
                      })
                        .then(onReload)
                        .catch((failure: unknown) => toast.error(messageOf(failure)))
                    }
                  >
                    <X />
                  </Button>
                ) : null}
              </div>
            ))}
          </div>
        </Section>
        <Section title="Add a collaborator" description="They'll need a Feedback account first.">
          <form
            className="grid gap-5"
            onSubmit={(event) => {
              event.preventDefault();
              const form = event.currentTarget;
              setBusy(true);
              void request(`/api/projects/${project.id}/members`, {
                method: 'POST',
                body: { email: formInput(form, 'email'), role },
              })
                .then(onReload)
                .then(() => {
                  form.reset();
                  toast.success('Collaborator added.');
                })
                .catch((failure: unknown) => toast.error(messageOf(failure)))
                .finally(() => {
                  setBusy(false);
                });
            }}
          >
            <Field label="Email address" id="member-email">
              <Input
                id="member-email"
                name="email"
                type="email"
                placeholder="teammate@example.com"
                required
                disabled={project.role !== 'owner'}
              />
            </Field>
            <Choice
              label="Project role"
              value={role}
              options={[
                { value: 'member', label: 'Member · Comment, reply, react' },
                { value: 'viewer', label: 'Viewer · Read conversations' },
                { value: 'owner', label: 'Owner · Manage project and agent work' },
              ]}
              onChange={setRole}
              disabled={project.role !== 'owner'}
            />
            {project.role === 'owner' ? (
              <Button type="submit" disabled={busy}>
                Add collaborator
              </Button>
            ) : (
              <p className="text-xs text-muted-foreground">Only owners can manage collaborators.</p>
            )}
          </form>
        </Section>
      </div>
    </>
  );
}
function Agents({
  project,
  agents,
  onReload,
}: {
  project: ProjectWithRole;
  agents: z.infer<typeof agentListSchema>;
  onReload: () => Promise<void>;
}) {
  const [credential, setCredential] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <>
      <PageHeading title="Agents" />
      <div className="grid items-start gap-6 xl:grid-cols-2">
        <div className="grid gap-6">
          <Section title="Connect an agent">
            <div className="grid gap-7">
              <Step number="1" title="Sign in from your terminal">
                <Code>{`feedback-toolbar login --server ${location.origin}`}</Code>
              </Step>
              <Step number="2" title="Link this project to your repository">
                <Code>{`feedback-toolbar init --server ${location.origin} --project ${project.id} --json`}</Code>
                <p>Run this from the repository your agent should work in.</p>
              </Step>
              <Step number="3" title="Schedule feedback checks in your harness">
                <Code>{`# Connect your existing agent harness\nfeedback-toolbar mcp --agent\n\n# In the harness schedule:\n# claim_work → heartbeat_work → complete_work`}</Code>
                <p>
                  Send to agent queues a request for the next scheduled check. Results return to the
                  same thread.
                </p>
              </Step>
            </div>
          </Section>
          <Section title="Agent-assisted setup">
            <p className="mb-4 text-xs leading-6 text-muted-foreground">
              Connect the MCP server to let an authenticated agent create projects, return
              installation instructions, and work through feedback.
            </p>
            <Code>
              {JSON.stringify(
                { mcpServers: { feedback: { command: 'feedback-toolbar', args: ['mcp'] } } },
                null,
                2,
              )}
            </Code>
          </Section>
        </div>
        <div className="grid gap-6">
          <Section title="Agent connections" description="Access is limited to this project.">
            {agents.length ? (
              <div className="-m-6">
                {agents.map((agent) => (
                  <div
                    key={agent.id}
                    className="flex items-center gap-3 border-b px-6 py-5 last:border-0"
                  >
                    <Person name={agent.name} agent />
                    <div className="flex-1">
                      <p className="text-xs font-medium">{agent.name}</p>
                      <p className="mt-1 text-[10px] text-muted-foreground">
                        Expires {new Date(agent.expiresAt).toLocaleDateString()}
                      </p>
                    </div>
                    <Button
                      variant="destructive"
                      size="xs"
                      onClick={() =>
                        void request(`/api/projects/${project.id}/credentials/${agent.id}`, {
                          method: 'DELETE',
                          body: {},
                        })
                          .then(onReload)
                          .catch((failure: unknown) => toast.error(messageOf(failure)))
                      }
                    >
                      Revoke
                    </Button>
                  </div>
                ))}
              </div>
            ) : (
              <Empty
                title="No agent connections"
                description="Link a connector or create a credential."
                symbol={<Bot className="size-5" />}
              />
            )}
          </Section>
          {project.role === 'owner' ? (
            <Section
              title="Create an agent credential"
              description="Read feedback, claim work, and post agent replies."
            >
              <form
                className="grid gap-5"
                onSubmit={(event) => {
                  event.preventDefault();
                  const form = event.currentTarget;
                  setBusy(true);
                  void request(`/api/projects/${project.id}/credentials`, {
                    method: 'POST',
                    body: { name: formInput(form, 'name') },
                  })
                    .then((result) => {
                      setCredential(z.object({ token: z.string() }).parse(result).token);
                      return onReload();
                    })
                    .catch((failure: unknown) => toast.error(messageOf(failure)))
                    .finally(() => {
                      setBusy(false);
                    });
                }}
              >
                <Field label="Connection name" id="agent-name">
                  <Input
                    id="agent-name"
                    name="name"
                    placeholder="My local Codex"
                    maxLength={80}
                    required
                  />
                </Field>
                <Button type="submit" disabled={busy}>
                  Create credential
                </Button>
                {credential ? (
                  <div>
                    <p className="mb-3 text-[11px] leading-5 text-muted-foreground">
                      Copy now; this credential is shown once. Keep it outside the repository.
                    </p>
                    <Code>{credential}</Code>
                  </div>
                ) : null}
              </form>
            </Section>
          ) : null}
          <p className="text-[11px] leading-6 text-muted-foreground">
            Only owners can start agent work. Agents cannot manage project permissions or start new
            work requests. Review changes before merging or deploying.
          </p>
        </div>
      </div>
    </>
  );
}

function Dashboard({
  user,
  onLogout,
  demoUrl,
}: {
  user: Account;
  onLogout: () => void;
  demoUrl: string;
}) {
  const [projects, setProjects] = useState<z.infer<typeof projectListSchema>>([]);
  const [selected, setSelected] = useState(() => localStorage.getItem('feedback-project-v1') ?? '');
  const [view, setView] = useState<View>('feedback');
  const [threads, setThreads] = useState<Thread[]>([]);
  const cachedThreads = useRef<Thread[]>([]);
  useEffect(() => {
    cachedThreads.current = threads;
  }, [threads]);
  const [activeDetail, setActiveDetail] = useState<Thread | null>(null);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const pagination = useRef<{ projectId: string; before: number | null; criteria: string }>({
    projectId: '',
    before: null,
    criteria: '',
  });
  const [jobs, setJobs] = useState<Work[]>([]);
  const [members, setMembers] = useState<z.infer<typeof memberListSchema>>([]);
  const [agents, setAgents] = useState<z.infer<typeof agentListSchema>>([]);
  const [newOpen, setNewOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [ready, setReady] = useState(false);
  const generation = useRef(0);
  const p = projects.find((item) => item.id === selected) ?? projects[0];
  const active =
    activeDetail?.id === activeId ? activeDetail : threads.find((thread) => thread.id === activeId);
  const refresh = useCallback(
    async (preferred?: string) => {
      const version = ++generation.current;
      const list = z
        .object({ projects: projectListSchema })
        .parse(await request('/api/projects')).projects;
      const chosen = list.find((item) => item.id === (preferred ?? selected)) ?? list[0];
      if (chosen) {
        const [data, people, connections, currentThread] = await Promise.all([
          request(
            `/api/projects/${chosen.id}/threads?q=${encodeURIComponent(search)}${filter === 'all' ? '' : `&status=${filter}`}`,
          ),
          request(`/api/projects/${chosen.id}/members`),
          chosen.role === 'owner'
            ? request(`/api/projects/${chosen.id}/credentials`)
            : Promise.resolve({ credentials: [] }),
          activeId ? request(`/api/threads/${activeId}`) : Promise.resolve(null),
        ]);
        if (version !== generation.current) return;
        const feedback = z
          .object({
            threads: z.array(threadSchema),
            jobs: z.array(publicJobSchema),
            nextBefore: z.number().nullable(),
          })
          .parse(data);
        const current = currentThread
          ? z.object({ thread: threadSchema, jobs: z.array(publicJobSchema) }).parse(currentThread)
          : null;
        if (current?.thread.projectId === chosen.id) {
          setActiveDetail(current.thread);
          feedback.threads = feedback.threads.map((thread) =>
            thread.id === current.thread.id ? current.thread : thread,
          );
          feedback.jobs = [
            ...feedback.jobs.filter((job) => job.threadId !== current.thread.id),
            ...current.jobs,
          ];
        }
        const criteria = JSON.stringify([search, filter]);
        if (
          pagination.current.projectId !== chosen.id ||
          pagination.current.criteria !== criteria
        ) {
          pagination.current = { projectId: chosen.id, before: feedback.nextBefore, criteria };
          setNextBefore(feedback.nextBefore);
        } else {
          // Refresh retained pages through the same server filters, including reply-only search.
          const ids = cachedThreads.current
            .filter(
              (thread) =>
                thread.projectId === chosen.id &&
                !feedback.threads.some((fresh) => fresh.id === thread.id),
            )
            .map((thread) => thread.id);
          const batches = Array.from({ length: Math.ceil(ids.length / 50) }, (_, index) =>
            ids.slice(index * 50, index * 50 + 50),
          );
          const retained = await Promise.all(
            batches.map(
              async (batch) =>
                z
                  .object({ threads: z.array(threadSchema) })
                  .parse(
                    await request(
                      `/api/projects/${chosen.id}/threads?q=${encodeURIComponent(search)}${filter === 'all' ? '' : `&status=${filter}`}&ids=${encodeURIComponent(batch.join(','))}`,
                    ),
                  ).threads,
            ),
          );
          if (version !== generation.current) return;
          feedback.threads.push(...retained.flat());
        }
        setThreads(feedback.threads);
        setJobs(feedback.jobs);
        setMembers(z.object({ members: memberListSchema }).parse(people).members);
        setAgents(z.object({ credentials: agentListSchema }).parse(connections).credentials);
        setSelected(chosen.id);
        localStorage.setItem('feedback-project-v1', chosen.id);
      }
      if (version === generation.current) {
        setProjects(list);
        setReady(true);
      }
    },
    [selected, search, filter, activeId],
  );
  useEffect(() => {
    void refresh().catch((failure: unknown) => toast.error(messageOf(failure)));
    const timer = setInterval(
      () => void refresh().catch((failure: unknown) => toast.error(messageOf(failure))),
      10000,
    );
    const counter = generation;
    return () => {
      clearInterval(timer);
      counter.current++;
    };
  }, [refresh]);
  const saveProject = async (input: unknown) => {
    if (!p) return;
    await request(`/api/projects/${p.id}`, { method: 'PATCH', body: input });
    await refresh();
  };
  const tryDemo = () => {
    if (!p) return;
    const destination = new URL(demoUrl);
    if (!p.origins.includes(destination.origin)) {
      toast.error('Add the example website origin in Installation first.');
      return;
    }
    destination.searchParams.set('project', p.id);
    destination.hash = 'feedback-connect';
    window.open(destination.href, '_blank', 'noopener');
  };
  const visible = threads.filter((thread) => filter === 'all' || thread.status === filter);
  const changeView = (next: View) => {
    setView(next);
    setActiveId(null);
  };
  return (
    <>
      <div className="grid min-h-screen grid-cols-1 lg:grid-cols-[224px_minmax(0,1fr)]">
        <aside className="flex min-w-0 flex-col gap-6 border-b bg-card p-5 lg:sticky lg:top-0 lg:h-screen lg:border-b-0 lg:border-r lg:py-7">
          <Brand small />
          <div className="rounded-lg border bg-muted/30 p-3">
            <Choice
              label="Project"
              value={p?.id ?? ''}
              options={projects.map((item) => ({ value: item.id, label: item.name }))}
              onChange={(value) => {
                setSelected(value);
                setActiveId(null);
                setNextBefore(null);
                setThreads([]);
              }}
            />
          </div>
          <nav className="flex gap-1 overflow-x-auto lg:grid" aria-label="Project navigation">
            {navigation.map(({ id, label, icon: Icon }) => (
              <Button
                key={id}
                variant="ghost"
                className={cn(
                  'h-10 shrink-0 justify-start gap-3 text-xs font-normal text-muted-foreground',
                  view === id && 'bg-secondary/60 font-medium text-secondary-foreground',
                )}
                onClick={() => {
                  changeView(id);
                }}
              >
                <Icon className="size-4" />
                {label}
                {id === 'feedback' &&
                threads.filter((thread) => thread.status === 'open').length ? (
                  <Badge variant="secondary" className="ml-auto text-[9px]">
                    {threads.filter((thread) => thread.status === 'open').length}
                  </Badge>
                ) : null}
              </Button>
            ))}
          </nav>
          <Button
            variant="ghost"
            size="sm"
            className="justify-start text-muted-foreground"
            onClick={() => {
              setNewOpen(true);
            }}
          >
            <Plus className="size-3.5" /> New project
          </Button>
          <div className="mt-auto hidden space-y-5 lg:block">
            <div className="flex items-center gap-2 border-t pt-4">
              <Person name={user.name} />
              <div className="min-w-0 flex-1 text-xs">
                <p>{user.name}</p>
                <p className="mt-1 text-[10px] capitalize text-muted-foreground">
                  {p?.role ?? 'Account'}
                </p>
              </div>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={<Button variant="ghost" size="icon-xs" aria-label="Account menu" />}
                >
                  <ArrowUpRight />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={onLogout}>
                    <LogOut /> Sign out
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </aside>
        <main className="min-w-0">
          <header className="flex h-[74px] items-center justify-between gap-4 border-b bg-card/60 px-6 sm:px-10">
            <div className="flex min-w-0 items-center gap-3 text-[11px] text-muted-foreground">
              <span className="truncate text-secondary-foreground">{p?.name ?? 'Projects'}</span>
              <span>/</span>
              <span>{navigation.find((item) => item.id === view)?.label}</span>
            </div>
            <div className="flex shrink-0 items-center gap-4">
              {p ? (
                <Button variant="outline" size="sm" onClick={tryDemo}>
                  Open example <ArrowUpRight />
                </Button>
              ) : null}
              <Button
                className="lg:hidden"
                variant="ghost"
                size="icon-xs"
                onClick={onLogout}
                aria-label="Sign out"
              >
                <LogOut />
              </Button>
            </div>
          </header>
          <div className="mx-auto max-w-[1280px] px-5 py-8 sm:px-10 sm:py-10">
            {!ready ? (
              <Empty title="Loading…" symbol={<Loader2 className="size-5 animate-spin" />} />
            ) : view === 'account' ? (
              <AccountSecurity />
            ) : !p ? (
              <Empty title="No projects" description="Create a project to install the toolbar.">
                <Button
                  onClick={() => {
                    setNewOpen(true);
                  }}
                >
                  <Plus /> Create your first project
                </Button>
              </Empty>
            ) : view === 'install' ? (
              <Installation key={p.id} project={p} onSave={saveProject} onDemo={tryDemo} />
            ) : view === 'appearance' ? (
              <Appearance key={p.id} project={p} onSave={saveProject} />
            ) : view === 'people' ? (
              <People project={p} members={members} onReload={refresh} />
            ) : view === 'agents' ? (
              <Agents project={p} agents={agents} onReload={refresh} />
            ) : (
              <>
                <PageHeading title="Feedback">
                  <Button className="h-9" onClick={tryDemo}>
                    <Target /> Leave feedback <ArrowUpRight />
                  </Button>
                </PageHeading>
                <div className="mb-4 flex items-center justify-between gap-4">
                  <h2 className="text-base font-medium">
                    Conversations{' '}
                    <span className="ml-1 text-sm font-normal text-muted-foreground">
                      {threads.length}
                    </span>
                  </h2>
                  <div className="relative max-w-[220px]">
                    <Search className="absolute left-2.5 top-2.5 size-3.5 text-muted-foreground" />
                    <Input
                      value={search}
                      onChange={(event) => {
                        setActiveId(null);
                        setNextBefore(null);
                        setThreads([]);
                        setSearch(event.target.value);
                      }}
                      placeholder="Search feedback…"
                      aria-label="Search feedback"
                      className="h-9 bg-card pl-8 text-xs"
                    />
                  </div>
                </div>
                <Card className="gap-0 overflow-hidden rounded-xl py-0 shadow-none">
                  <Tabs
                    value={filter}
                    onValueChange={(value) => {
                      if (typeof value === 'string') {
                        setActiveId(null);
                        setNextBefore(null);
                        setThreads([]);
                        setFilter(value);
                      }
                    }}
                  >
                    <TabsList variant="line" className="h-14 gap-6 border-b px-6">
                      {[
                        { id: 'all', label: 'All feedback' },
                        { id: 'open', label: 'Open' },
                        { id: 'resolved', label: 'Resolved' },
                      ].map((tab) => (
                        <TabsTrigger
                          key={tab.id}
                          value={tab.id}
                          className="h-14 px-0 text-xs after:bottom-0"
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
                            <p data-feedback-content className="line-clamp-2 text-xs leading-6">
                              {first?.body}
                            </p>
                            <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
                              <span data-feedback-content>{first?.author}</span>
                              <span>·</span>
                              <span data-feedback-content>
                                {new URL(thread.context.url).pathname}
                              </span>
                              <span>·</span>
                              <span>{thread.context.anchor.tag}</span>
                              <Badge variant="secondary" className="text-[9px]">
                                {thread.status}
                              </Badge>
                              {job ? <JobBadge job={job} /> : null}
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
                {nextBefore ? (
                  <Button
                    variant="outline"
                    className="mt-4"
                    onClick={() => {
                      const projectId = p.id;
                      const criteria = JSON.stringify([search, filter]);
                      if (
                        pagination.current.projectId !== projectId ||
                        pagination.current.criteria !== criteria
                      )
                        return;
                      const version = ++generation.current;
                      void request(
                        `/api/projects/${projectId}/threads?before=${nextBefore}&q=${encodeURIComponent(search)}${filter === 'all' ? '' : `&status=${filter}`}`,
                      )
                        .then((data) => {
                          if (
                            version !== generation.current ||
                            pagination.current.projectId !== projectId ||
                            pagination.current.criteria !== criteria
                          )
                            return;
                          const page = z
                            .object({
                              threads: z.array(threadSchema),
                              nextBefore: z.number().nullable(),
                            })
                            .parse(data);
                          setThreads((previous) => [
                            ...previous,
                            ...page.threads.filter(
                              (thread) => !previous.some((current) => current.id === thread.id),
                            ),
                          ]);
                          pagination.current.before = page.nextBefore;
                          setNextBefore(page.nextBefore);
                        })
                        .catch((failure: unknown) => toast.error(messageOf(failure)));
                    }}
                  >
                    Load earlier conversations
                  </Button>
                ) : null}
              </>
            )}
          </div>
        </main>
      </div>
      <NewProject
        open={newOpen}
        onOpenChange={setNewOpen}
        demoUrl={demoUrl}
        onCreated={async (next) => {
          setSelected(next.id);
          setView('install');
          await refresh(next.id);
          toast.success('Project created.');
        }}
      />
      <Dialog
        open={!!active}
        onOpenChange={(open) => {
          if (!open) setActiveId(null);
        }}
      >
        <DialogContent className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-[620px]">
          <DialogHeader className="border-b px-5 py-5">
            <DialogTitle className="text-lg">Thread</DialogTitle>
            <DialogDescription className="sr-only">
              Feedback attached to a website element, with replies and agent work.
            </DialogDescription>
          </DialogHeader>
          {active && p ? (
            <Conversation
              key={active.id}
              thread={active}
              job={jobs.filter((job) => job.threadId === active.id).at(-1)}
              role={p.role}
              onReply={async (body) => {
                await request(`/api/threads/${active.id}/messages`, {
                  method: 'POST',
                  body: { body },
                });
                await refresh();
              }}
              onReact={async (messageId, emoji) => {
                await request(`/api/threads/${active.id}/reactions`, {
                  method: 'POST',
                  body: { messageId, emoji },
                });
                await refresh();
              }}
              onSend={async () => {
                await request(`/api/threads/${active.id}/work`, {
                  method: 'POST',
                  body: { revision: active.revision, idempotencyKey: crypto.randomUUID() },
                });
                await refresh();
                toast.success('Queued.');
              }}
              onResolve={async () => {
                await request(`/api/threads/${active.id}`, {
                  method: 'PATCH',
                  body: { status: active.status === 'open' ? 'resolved' : 'open' },
                });
                await refresh();
              }}
              onCancel={async () => {
                const job = jobs.filter((job) => job.threadId === active.id).at(-1);
                if (job) {
                  await request(`/api/work/${job.id}/cancel`, { method: 'POST', body: {} });
                  await refresh();
                }
              }}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
function App() {
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const update = () => {
      applyTheme(defaultTheme);
    };
    update();
    media.addEventListener('change', update);
    return () => {
      media.removeEventListener('change', update);
    };
  }, []);
  const [user, setUser] = useState<Account | null>(null);
  const [ready, setReady] = useState(false);
  const [config, setConfig] = useState({
    demoUrl: 'http://localhost:4311',
    allowSignup: true,
    github: false,
    localPassword: true,
  });
  const [error, setError] = useState('');
  useEffect(() => {
    void (async () => {
      const data = z
        .object({
          demoUrl: z.string(),
          allowSignup: z.boolean(),
          github: z.boolean(),
          localPassword: z.boolean(),
        })
        .parse(await request('/api/config'));
      setConfig(data);
      try {
        setUser(z.object({ user: publicUserSchema }).parse(await request('/api/me')).user);
      } catch {
        /* A new visitor is shown the independent sign-in screen. */
      }
      setReady(true);
    })().catch((failure: unknown) => {
      setError(messageOf(failure));
    });
  }, []);
  useEffect(() => {
    let active = true;
    const check = () => {
      void request('/api/auth/get-session')
        .then((session) => {
          if (!active) return;
          setUser(
            session === null ? null : z.object({ user: publicUserSchema }).parse(session).user,
          );
        })
        .catch(() => {
          /* A network outage retains the current screen until the next check. */
        });
    };
    const timer = setInterval(check, 60_000);
    window.addEventListener('focus', check);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener('focus', check);
    };
  }, []);
  const logout = () =>
    void request('/api/auth/sign-out', { method: 'POST', body: {} })
      .then(() => {
        setUser(null);
      })
      .catch((failure: unknown) => toast.error(messageOf(failure)));
  return (
    <TooltipProvider>
      <Toaster position="bottom-center" richColors />
      {error ? (
        <Empty title="Couldn't open Feedback." description={error} />
      ) : !ready ? (
        <Empty title="Loading…" symbol={<Loader2 className="animate-spin" />} />
      ) : !user ? (
        <Auth
          onSignIn={setUser}
          allowSignup={config.allowSignup}
          github={config.github}
          localPassword={config.localPassword}
        />
      ) : grant ? (
        <Consent user={user} onLogout={logout} />
      ) : (
        <Dashboard key={user.id} user={user} onLogout={logout} demoUrl={config.demoUrl} />
      )}
    </TooltipProvider>
  );
}
const nonce = document.querySelector('meta[name=csp-nonce]')?.getAttribute('content') ?? undefined;
createRoot(rootElement()).render(
  <CSPProvider nonce={nonce}>
    <App />
  </CSPProvider>,
);
