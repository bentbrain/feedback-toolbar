import { useState } from 'react';
import type { ReactNode } from 'react';
import { Check, Copy, MessageCircle, Bot, Send, Target, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from './ui/button.js';
import { Avatar, AvatarFallback } from './ui/avatar.js';
import { Badge } from './ui/badge.js';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card.js';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from './ui/select.js';
import { Label } from './ui/label.js';
import { Textarea } from './ui/textarea.js';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip.js';
import { cn } from '../lib/utils.js';
import { initials, relativeTime } from '../ui.js';
import type { Thread } from '../../shared/models.js';
import { publicJobSchema } from '../../shared/models.js';
import { z } from 'zod';

export type Work = z.infer<typeof publicJobSchema>;
export function Brand({ small = false }: { small?: boolean }) {
  return (
    <div
      className={cn(
        'flex items-center gap-2.5 text-xl font-semibold tracking-tight',
        small && 'text-sm',
      )}
    >
      <span
        className={cn(
          'grid size-8 place-items-center rounded-xl bg-primary text-primary-foreground',
          small && 'size-7 rounded-lg',
        )}
      >
        <MessageCircle className="size-4" />
      </span>
      toolbar.bent.build
    </div>
  );
}
export function Person({
  name,
  agent = false,
  small = false,
}: {
  name: string;
  agent?: boolean;
  small?: boolean;
}) {
  return (
    <Avatar className={cn('size-8', small && 'size-7')}>
      <AvatarFallback
        className={cn(
          'bg-secondary text-[10px] text-secondary-foreground',
          agent && 'rounded-lg text-primary',
        )}
      >
        {agent ? <Bot className="size-3.5" /> : initials(name)}
      </AvatarFallback>
    </Avatar>
  );
}
export function PageHeading({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div className="mb-7 flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="text-[28px] font-medium tracking-[-1px] sm:text-[30px]">{title}</h1>
        <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">{description}</p>
      </div>
      {children}
    </div>
  );
}
export function Section({
  title,
  description,
  children,
  className,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Card className={cn('gap-0 rounded-xl py-0 shadow-none', className)}>
      <CardHeader className="border-b px-6 py-5">
        <CardTitle className="text-base font-medium">{title}</CardTitle>
        {description ? <CardDescription className="text-xs">{description}</CardDescription> : null}
      </CardHeader>
      <CardContent className="p-6">{children}</CardContent>
    </Card>
  );
}
export function Empty({
  title,
  description,
  children,
  symbol,
}: {
  title: string;
  description: string;
  children?: ReactNode;
  symbol?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 px-5 py-12 text-center">
      <div className="mb-1 grid size-12 place-items-center rounded-2xl border bg-muted/50 text-secondary-foreground">
        {symbol ?? <MessageCircle className="size-5" />}
      </div>
      <h3 className="text-sm font-medium">{title}</h3>
      <p className="max-w-xs text-xs leading-6 text-muted-foreground">{description}</p>
      {children}
    </div>
  );
}
export function Code({ children, copy = true }: { children: string; copy?: boolean }) {
  return (
    <div className="relative">
      <pre
        className={cn(
          'overflow-x-auto whitespace-pre-wrap break-all rounded-lg border bg-muted/40 p-4 font-mono text-[11px] leading-6 text-secondary-foreground',
          copy && 'pr-12',
        )}
      >
        {children}
      </pre>
      {copy ? (
        <Button
          variant="ghost"
          size="icon-xs"
          className="absolute right-2 top-2 text-muted-foreground"
          aria-label="Copy code"
          onClick={() =>
            void navigator.clipboard.writeText(children).then(
              () => toast.success('Copied to clipboard.'),
              () => toast.error('Could not access your clipboard.'),
            )
          }
        >
          <Copy className="size-3" />
        </Button>
      ) : null}
    </div>
  );
}
export function Choice({
  label,
  value,
  options,
  onChange,
  disabled = false,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="grid gap-2">
      <Label className="text-xs text-secondary-foreground">{label}</Label>
      <Select
        value={value}
        onValueChange={(next) => {
          if (typeof next === 'string') onChange(next);
        }}
        items={options}
        disabled={disabled}
      >
        <SelectTrigger className="w-full bg-card" aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent alignItemWithTrigger={false}>
          {options.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
export function IconAction({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<Button variant="ghost" size="icon-sm" aria-label={label} onClick={onClick} />}
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
export function JobBadge({ job }: { job: Work }) {
  return (
    <Badge
      variant="secondary"
      className={cn(
        'border-0 text-[10px]',
        ['queued', 'running'].includes(job.status) && 'bg-orange-50 text-orange-700',
        job.status === 'review' && 'bg-indigo-50 text-indigo-600',
        job.status === 'failed' && 'bg-red-50 text-red-600',
      )}
    >
      {job.status === 'review' ? 'Ready for review' : job.status}
    </Badge>
  );
}
export function MiniWebsite() {
  return (
    <div aria-hidden="true" className="relative mx-auto w-full max-w-[290px] pb-7">
      <div className="rounded-xl border border-border bg-card p-3 shadow-sm">
        <div className="mb-5 flex gap-1 border-b pb-2">
          {[1, 2, 3].map((item) => (
            <i key={item} className="size-1 rounded-full bg-primary/20" />
          ))}
        </div>
        <div className="mx-2">
          <div className="mb-2 h-2 w-3/4 rounded bg-primary/20" />
          <div className="h-2 w-1/2 rounded bg-primary/10" />
          <div className="mb-2 mt-5 flex gap-2">
            {[1, 2, 3].map((item) => (
              <div key={item} className="h-12 flex-1 rounded bg-muted" />
            ))}
          </div>
        </div>
      </div>
      <div className="absolute -bottom-0 right-0 flex items-center gap-2 rounded-xl border bg-card px-3 py-3 shadow-sm">
        <div className="grid size-7 place-items-center rounded-full bg-secondary text-secondary-foreground">
          <MessageCircle className="size-3" />
        </div>
        <div className="text-[10px]">
          <strong className="font-medium text-foreground">element comments</strong>
          <p className="mt-1 text-[9px] text-muted-foreground">threads and agent replies</p>
        </div>
      </div>
    </div>
  );
}
export function Conversation({
  thread,
  job,
  role,
  onReply,
  onReact,
  onSend,
  onResolve,
  onHighlight,
  onCancel,
  compact = false,
}: {
  thread: Thread;
  job?: Work | undefined;
  role: string;
  onReply: (body: string) => Promise<void>;
  onReact: (messageId: string, emoji: string) => Promise<void>;
  onSend: () => Promise<void>;
  onResolve: () => Promise<void>;
  onHighlight?: (() => void) | undefined;
  onCancel?: (() => Promise<void>) | undefined;
  compact?: boolean;
}) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const work = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await action();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not complete this action.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={cn('flex min-h-0 flex-1 flex-col', compact && 'text-xs')}>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <div className="mb-5 rounded-lg border bg-muted/40 p-3">
          <code className="block break-all text-[10px] text-primary">
            {thread.context.anchor.selector}
          </code>
          <p
            data-feedback-content
            className="mt-2 line-clamp-2 text-[11px] leading-5 text-muted-foreground"
          >
            {thread.context.anchor.text || thread.context.anchor.tag}
          </p>
          {onHighlight ? (
            <Button
              variant="ghost"
              size="xs"
              className="mt-2 text-muted-foreground"
              onClick={onHighlight}
            >
              <Target className="size-3" /> Show element
            </Button>
          ) : (
            <p className="mt-2 break-all text-[10px] text-muted-foreground">
              {thread.context.url} · {thread.context.viewport.width} ×{' '}
              {thread.context.viewport.height}
            </p>
          )}
        </div>
        {thread.messages.map((message) => (
          <div key={message.id} className="mb-5 flex gap-2.5">
            <Person name={message.author} agent={message.kind === 'agent'} small />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2 text-[11px]">
                <strong data-feedback-content className="font-medium">
                  {message.author}
                </strong>
                {message.kind === 'agent' ? (
                  <Badge variant="secondary" className="text-[9px]">
                    Agent
                  </Badge>
                ) : null}
                <time className="text-[10px] text-muted-foreground">
                  {relativeTime(message.createdAt)}
                </time>
              </div>
              <p
                data-feedback-content
                className="mt-2 whitespace-pre-wrap break-words text-xs leading-6"
              >
                {message.body}
              </p>
              <div className="mt-2 flex gap-1">
                {['👍', '❤️', '👀', '🎉'].map((emoji) => {
                  const reactions = message.reactions.filter(
                    (reaction) => reaction.emoji === emoji,
                  );
                  return (
                    <Button
                      key={emoji}
                      variant="outline"
                      size="xs"
                      className="h-6 px-1.5 text-[10px]"
                      aria-label={`React with ${emoji}`}
                      disabled={busy || role === 'viewer'}
                      onClick={() => void work(() => onReact(message.id, emoji))}
                    >
                      {emoji}
                      {reactions.length || ''}
                    </Button>
                  );
                })}
              </div>
            </div>
          </div>
        ))}
        {job ? (
          <div className="space-y-2">
            <JobBadge job={job} />
            {job.status === 'review' &&
            job.result &&
            !thread.messages.some((message) => message.id === job.id) ? (
              <p data-feedback-content className="whitespace-pre-wrap text-xs leading-6">
                {job.result}
              </p>
            ) : null}
            <p className="text-[11px] leading-5 text-muted-foreground">
              {job.status === 'queued'
                ? 'Waiting for your local connector. Your request is saved.'
                : job.status === 'running'
                  ? (job.leaseExpiresAt ?? 0) < Date.now()
                    ? 'The runner lost connection. Check its local run record before cancelling or requesting a retry.'
                    : 'Your agent is working on this feedback.'
                  : job.status === 'review'
                    ? 'Review the proposed change before resolving this thread.'
                    : job.status === 'failed' && job.result
                      ? job.result
                      : `Work ${job.status}.`}
            </p>
          </div>
        ) : null}
      </div>
      {role !== 'viewer' ? (
        <form
          className="grid gap-3 border-t bg-card px-5 py-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (draft.trim())
              void work(async () => {
                await onReply(draft);
                setDraft('');
              });
          }}
        >
          <Label htmlFor={`reply-${thread.id}`} className="sr-only">
            Reply
          </Label>
          <Textarea
            id={`reply-${thread.id}`}
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
            }}
            placeholder="Reply to the conversation…"
            className="min-h-16 resize-none text-xs"
            maxLength={8000}
            required
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap gap-1">
              {role === 'owner' ? (
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  disabled={busy || (!!job && ['queued', 'running'].includes(job.status))}
                  onClick={() => void work(onSend)}
                >
                  <Bot className="size-3" /> Send to agent
                </Button>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={busy}
                onClick={() => void work(onResolve)}
              >
                <Check className="size-3" />
                {thread.status === 'open' ? 'Resolve' : 'Reopen'}
              </Button>
              {role === 'owner' && onCancel && job && ['queued', 'running'].includes(job.status) ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  disabled={busy}
                  onClick={() => void work(onCancel)}
                >
                  Cancel work
                </Button>
              ) : null}
            </div>
            <Button size="sm" type="submit" disabled={busy || !draft.trim()}>
              {busy ? <Loader2 className="size-3 animate-spin" /> : <Send className="size-3" />}
              Reply
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
