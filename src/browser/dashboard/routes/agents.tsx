import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Bot } from 'lucide-react';
import { z } from 'zod';
import { toast } from 'sonner';
import { formInput, messageOf, request } from '../../ui.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Code, Empty, PageHeading, Person, Section } from '../../components/common.js';

import { agentListSchema } from '../models.js';
import type { ProjectWithRole } from '../models.js';
import { Field, Step } from '../fields.js';
import { useProject } from '../project-layout.js';

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
      <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-2">
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
                    <div className="min-w-0 flex-1">
                      <p
                        data-feedback-content
                        className="truncate text-xs font-medium"
                        title={agent.name}
                      >
                        {agent.name}
                      </p>
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

export default function AgentsRoute() {
  const { project, refresh } = useProject();
  const query = useQuery({
    queryKey: ['agents', project.id],
    queryFn: async ({ signal }) =>
      z
        .object({ credentials: agentListSchema })
        .parse(await request(`/api/projects/${project.id}/credentials`, { signal })).credentials,
    enabled: project.role === 'owner',
    refetchInterval: 10_000,
  });
  useEffect(() => {
    if (query.error) toast.error(messageOf(query.error));
  }, [query.error]);
  return <Agents key={project.id} project={project} agents={query.data ?? []} onReload={refresh} />;
}
