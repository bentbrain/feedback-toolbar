import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { defaultEmojiDataResolver } from 'frimousse';
import type { EmojiDataResolver } from 'frimousse';
import { Loader2, SmilePlus } from 'lucide-react';
import type { Thread } from '../../shared/models.js';
import { getEmojiFavourites, recordEmojiChoice } from '../emoji-favourites.js';
import { Button } from './ui/button.js';
import {
  EmojiPicker,
  EmojiPickerContent,
  EmojiPickerFooter,
  EmojiPickerSearch,
} from './ui/emoji-picker.js';
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from './ui/popover.js';

function ReactionPicker({
  actorId,
  onSelect,
  retryRef,
}: {
  actorId: string | undefined;
  onSelect: (emoji: string) => void;
  retryRef: RefObject<HTMLButtonElement | null>;
}) {
  const [favourites] = useState(() => (actorId ? getEmojiFavourites(actorId) : []));
  const [failed, setFailed] = useState(false);
  const errorId = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const [columns, setColumns] = useState(8);
  const retrying = useRef(false);
  useEffect(() => {
    const picker = pickerRef.current;
    if (!picker) return;
    const resize = () => {
      const viewport = picker.querySelector('[data-slot="emoji-picker-viewport"]');
      const row = picker.querySelector('[data-slot="emoji-picker-row"]');
      const emoji = picker.querySelector('[data-slot="emoji-picker-emoji"]');
      if (!viewport || !row || !emoji) return;
      const width = parseFloat(getComputedStyle(emoji).width);
      if (!width) return;
      const style = getComputedStyle(row);
      const available =
        viewport.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      setColumns(Math.max(1, Math.min(8, Math.floor(available / width))));
    };
    const observer = new ResizeObserver(resize);
    observer.observe(picker);
    const viewport = picker.querySelector('[data-slot="emoji-picker-viewport"]');
    if (viewport) observer.observe(viewport);
    window.addEventListener('resize', resize);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', resize);
    };
  }, [failed]);
  useEffect(() => {
    if (failed) retryRef.current?.focus();
    else if (retrying.current) {
      retrying.current = false;
      searchRef.current?.focus();
    }
  }, [failed, retryRef]);
  const resolveEmojiData = useCallback<EmojiDataResolver>(async (locale, options) => {
    try {
      return await defaultEmojiDataResolver(locale, options);
    } catch (error) {
      setFailed(true);
      throw error;
    }
  }, []);
  return failed ? (
    <div className="grid gap-2 p-3">
      <p id={errorId} role="alert" className="text-xs text-muted-foreground">
        Could not load emojis.
      </p>
      <Button
        ref={retryRef}
        type="button"
        size="sm"
        variant="outline"
        aria-describedby={errorId}
        onClick={() => {
          retrying.current = true;
          setFailed(false);
        }}
      >
        Retry
      </Button>
    </div>
  ) : (
    <EmojiPicker
      ref={pickerRef}
      locale="en"
      emojibaseUrl={`${location.origin}/api/emoji-data/v1`}
      resolveEmojiData={resolveEmojiData}
      columns={columns}
      className="h-[min(342px,var(--available-height))]"
      onEmojiSelect={({ emoji }) => {
        onSelect(emoji);
      }}
    >
      <EmojiPickerSearch ref={searchRef} aria-label="Search emojis" placeholder="Search emojis" />
      {favourites.length > 0 ? (
        <div className="shrink-0 border-b p-2">
          <p className="mb-1 px-1 text-xs text-muted-foreground">Favourites</p>
          <div role="group" aria-label="Favourite emojis" className="flex flex-wrap">
            {favourites.map((emoji) => (
              <Button
                key={emoji}
                type="button"
                variant="ghost"
                size="icon-sm"
                className="size-8 shrink-0 p-0 text-lg"
                aria-label={`React with ${emoji}`}
                onClick={() => {
                  onSelect(emoji);
                }}
              >
                {emoji}
              </Button>
            ))}
          </div>
        </div>
      ) : null}
      <EmojiPickerContent />
      <EmojiPickerFooter />
    </EmojiPicker>
  );
}

export function MessageReactions({
  message,
  actorId,
  disabled,
  onReact,
}: {
  message: Thread['messages'][number];
  actorId: string | undefined;
  disabled: boolean;
  onReact: (emoji: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const reacting = useRef(false);
  const retryRef = useRef<HTMLButtonElement>(null);
  const emojis = [...new Set(message.reactions.map((reaction) => reaction.emoji))];
  const react = async (emoji: string) => {
    if (disabled || reacting.current) return;
    reacting.current = true;
    setPending(emoji);
    setOpen(false);
    const removing = message.reactions.some(
      (reaction) => reaction.emoji === emoji && reaction.actorId === actorId,
    );
    try {
      await onReact(emoji);
      if (actorId && !removing) await recordEmojiChoice(actorId, emoji);
    } finally {
      reacting.current = false;
      setPending(null);
    }
  };
  return (
    <div
      role="group"
      className="mt-2 flex flex-wrap items-center gap-1"
      aria-label="Reactions"
      aria-busy={pending !== null}
    >
      {emojis.map((emoji) => {
        const reactions = message.reactions.filter((reaction) => reaction.emoji === emoji);
        const pressed =
          actorId === undefined
            ? undefined
            : reactions.some((reaction) => reaction.actorId === actorId);
        return (
          <Button
            key={emoji}
            type="button"
            variant="outline"
            size="xs"
            className="h-7 min-w-9 gap-1.5 px-1.5 text-xs aria-pressed:bg-accent"
            aria-label={`React with ${emoji}`}
            aria-pressed={pressed}
            aria-description={
              reactions.length
                ? `${reactions.length} ${reactions.length === 1 ? 'reaction' : 'reactions'}: ${reactions.map((reaction) => reaction.name).join(', ')}`
                : undefined
            }
            title={
              reactions.length ? reactions.map((reaction) => reaction.name).join(', ') : undefined
            }
            disabled={disabled || pending !== null}
            onClick={() => void react(emoji)}
          >
            {pending === emoji ? <Loader2 className="size-3 animate-spin" /> : <span>{emoji}</span>}
            {reactions.length > 1 ? <span className="tabular-nums">{reactions.length}</span> : null}
          </Button>
        );
      })}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              className="w-9"
              aria-label="Add reaction"
              disabled={disabled || pending !== null}
            />
          }
        >
          {pending && !emojis.includes(pending) ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <SmilePlus className="size-3.5" />
          )}
        </PopoverTrigger>
        <PopoverContent
          onFocus={(event) => {
            // Base UI restores popup focus after the failed search input is removed.
            if (event.target === event.currentTarget) retryRef.current?.focus();
          }}
          align="start"
          side="top"
          className="w-[min(288px,var(--available-width))] gap-0 overflow-hidden p-0"
        >
          <PopoverTitle className="sr-only">Add reaction</PopoverTitle>
          {open ? (
            <ReactionPicker
              actorId={actorId}
              retryRef={retryRef}
              onSelect={(emoji) => void react(emoji)}
            />
          ) : null}
        </PopoverContent>
      </Popover>
    </div>
  );
}
