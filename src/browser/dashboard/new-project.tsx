import { useRef, useState } from 'react';
import type { SubmitEvent } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { z } from 'zod';
import { projectSchema } from '../../shared/models.js';
import type { Project } from '../../shared/models.js';
import { formInput, messageOf, request } from '../ui.js';
import { Button } from '../components/ui/button.js';
import { Input } from '../components/ui/input.js';
import { Textarea } from '../components/ui/textarea.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog.js';

import { Field } from './fields.js';

export function NewProject({
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
