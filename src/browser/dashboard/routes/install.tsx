import { useState } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { toast } from 'sonner';
import { installation } from '../../../shared/models.js';
import { messageOf } from '../../ui.js';
import { Button } from '../../components/ui/button.js';
import { Textarea } from '../../components/ui/textarea.js';
import { Code, PageHeading, Section } from '../../components/common.js';

import type { ProjectWithRole } from '../models.js';
import { Field, Step } from '../fields.js';
import { useProject } from '../project-layout.js';

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
      <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-2">
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
                    className="h-auto min-h-7 max-w-full whitespace-normal break-all"
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
              <Button
                variant="outline"
                size="sm"
                className="h-auto min-h-7 whitespace-normal"
                onClick={onDemo}
              >
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

export default function InstallationRoute() {
  const { project, saveProject, tryDemo } = useProject();
  return <Installation key={project.id} project={project} onSave={saveProject} onDemo={tryDemo} />;
}
