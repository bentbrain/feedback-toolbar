import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Check, Copy, MessageCircle, Bot, Send, Target, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from './ui/button.js';
import { Avatar, AvatarFallback } from './ui/avatar.js';
import { Badge } from './ui/badge.js';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card.js';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from './ui/select.js';
import { Field, FieldLabel } from './ui/field.js';
import { Label } from './ui/label.js';
import {
  Empty as EmptyState,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
  EmptyContent,
} from './ui/empty.js';
import { Textarea } from './ui/textarea.js';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip.js';
import { cn } from '../lib/utils.js';
import { initials, relativeTime } from '../ui.js';
import type { Thread } from '../../shared/models.js';
import { publicJobSchema } from '../../shared/models.js';
import { z } from 'zod';
import { MessageReactions } from './message-reactions.js';

export type Work = z.infer<typeof publicJobSchema>;
export function Brand({ small = false }: { small?: boolean }) {
  return (
    <div
      className={cn(
        'flex min-w-0 items-center gap-2.5 text-xl font-semibold tracking-tight',
        small && 'text-sm',
      )}
    >
      <span
        className={cn(
          'grid size-8 shrink-0 place-items-center rounded-xl bg-primary text-primary-foreground',
          small && 'size-7 rounded-lg',
        )}
      >
        <MessageCircle className="size-4" />
      </span>
      <span className="truncate">toolbar.bent.build</span>
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
  description?: string;
  children?: ReactNode;
}) {
  return (
    <div className="mb-7 flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="text-[28px] font-medium tracking-[-1px] sm:text-[30px]">{title}</h1>
        {description ? (
          <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">{description}</p>
        ) : null}
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
    <Card className={cn('min-w-0 gap-0 rounded-xl py-0 shadow-none', className)}>
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
  description?: string;
  children?: ReactNode;
  symbol?: ReactNode;
}) {
  return (
    <EmptyState className="gap-3 px-5 py-12">
      <EmptyHeader className="gap-3">
        <EmptyMedia
          variant="icon"
          className="mb-1 size-12 rounded-2xl border bg-muted/50 text-secondary-foreground"
        >
          {symbol ?? <MessageCircle className="size-5" />}
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        {description ? (
          <EmptyDescription className="max-w-xs text-xs leading-6">{description}</EmptyDescription>
        ) : null}
      </EmptyHeader>
      {children ? <EmptyContent>{children}</EmptyContent> : null}
    </EmptyState>
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
    <Field>
      <FieldLabel className="text-xs text-secondary-foreground">{label}</FieldLabel>
      <Select
        value={value}
        onValueChange={(next) => {
          if (typeof next === 'string') onChange(next);
        }}
        items={options}
        disabled={disabled}
      >
        <SelectTrigger className="w-full min-w-0 max-w-full bg-card" aria-label={label}>
          <SelectValue data-feedback-content />
        </SelectTrigger>
        <SelectContent alignItemWithTrigger={false}>
          {options.map((item) => (
            <SelectItem key={item.value} value={item.value} data-feedback-content>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
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
  actorId,
}: {
  actorId?: string | undefined;
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
  const [pending, setPending] = useState('');
  const locked = useRef(false);
  const actionError = useRef<string | number | null>(null);
  const busy = Boolean(pending);
  const work = async (label: string, action: () => Promise<void>) => {
    if (locked.current) return;
    locked.current = true;
    if (actionError.current !== null) toast.dismiss(actionError.current);
    actionError.current = null;
    setPending(label);
    try {
      await action();
    } catch (error) {
      actionError.current = toast.error(
        error instanceof Error ? error.message : 'Could not complete this action.',
      );
    } finally {
      locked.current = false;
      setPending('');
    }
  };
  return (
    <div
      className={cn(
        'flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain',
        compact && 'text-xs',
      )}
    >
      <div className="min-h-24 flex-1 overflow-y-auto px-5 py-4">
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
                <strong
                  data-feedback-content
                  className="min-w-0 max-w-full break-words font-medium"
                >
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
              <MessageReactions
                message={message}
                actorId={actorId}
                disabled={busy || role === 'viewer'}
                onReact={(emoji) => work('react', () => onReact(message.id, emoji))}
              />
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
                ? 'Queued. Waiting for the agent.'
                : job.status === 'running'
                  ? (job.leaseExpiresAt ?? 0) < Date.now()
                    ? 'The runner lost connection. Check its local run record before cancelling or requesting a retry.'
                    : 'Agent running.'
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
          className="grid shrink-0 gap-3 border-t bg-card px-5 py-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (draft.trim())
              void work('reply', async () => {
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
            placeholder="Reply…"
            className="max-h-32 min-h-16 resize-none overflow-y-auto text-xs"
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
                  onClick={() => void work('send', onSend)}
                >
                  {pending === 'send' ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <Bot className="size-3" />
                  )}
                  {pending === 'send' ? 'Sending to agent…' : 'Send to agent'}
                </Button>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={busy}
                onClick={() => void work('resolve', onResolve)}
              >
                <Check className="size-3" />
                {pending === 'resolve'
                  ? 'Saving…'
                  : thread.status === 'open'
                    ? 'Resolve'
                    : 'Reopen'}
              </Button>
              {role === 'owner' && onCancel && job && ['queued', 'running'].includes(job.status) ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  disabled={busy}
                  onClick={() => void work('cancel', onCancel)}
                >
                  {pending === 'cancel' ? 'Cancelling…' : 'Cancel work'}
                </Button>
              ) : null}
            </div>
            <Button size="sm" type="submit" disabled={busy || !draft.trim()}>
              {pending === 'reply' ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Send className="size-3" />
              )}
              {pending === 'reply' ? 'Replying…' : 'Reply'}
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
