import { useLayoutEffect, useRef, useState } from 'react';
import { Bot, MessageCircle, X, Sun, Moon, Monitor } from 'lucide-react';
import { toast } from 'sonner';
import { defaultTheme, themeSchema } from '../../../shared/models.js';
import type { Theme } from '../../../shared/models.js';
import { applyTheme, messageOf } from '../../ui.js';
import { cn } from '../../lib/utils.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
import { Card } from '../../components/ui/card.js';
import { Tabs, TabsList, TabsTrigger } from '../../components/ui/tabs.js';
import { Choice, PageHeading, Person, Section } from '../../components/common.js';

import type { ProjectWithRole } from '../models.js';
import { useProject } from '../project-layout.js';

function ToolbarPreview({ theme, name }: { theme: Theme; name: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const update = () => {
      if (ref.current) applyTheme(theme, ref.current);
    };
    update();
    media.addEventListener('change', update);
    return () => {
      media.removeEventListener('change', update);
    };
  }, [theme]);
  return (
    <div ref={ref} className="w-full max-w-[340px]">
      <Card className="gap-0 overflow-hidden rounded-lg py-0 shadow-lg shadow-black/5">
        <div className="flex items-center justify-between border-b px-5 py-4">
          <div className="flex min-w-0 items-center gap-2">
            <MessageCircle className="size-4 shrink-0 text-primary" />
            <div className="min-w-0 text-sm font-medium">
              Feedback
              <p
                data-feedback-content
                className="mt-0.5 truncate text-[10px] font-normal text-muted-foreground"
                title={name}
              >
                {name}
              </p>
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
      <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-2">
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
                      className="flex h-full min-w-0 flex-col gap-2 rounded-lg border px-2 text-xs capitalize data-active:border-secondary-foreground/60 data-active:bg-secondary/30 sm:px-5"
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
        <div className="min-w-0">
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

export default function AppearanceRoute() {
  const { project, saveProject } = useProject();
  return <Appearance key={project.id} project={project} onSave={saveProject} />;
}
