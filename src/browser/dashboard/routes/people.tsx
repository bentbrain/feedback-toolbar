import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { z } from 'zod';
import { toast } from 'sonner';
import { formInput, messageOf, request } from '../../ui.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Badge } from '../../components/ui/badge.js';
import { Choice, PageHeading, Person, Section } from '../../components/common.js';

import { memberListSchema } from '../models.js';
import type { ProjectWithRole } from '../models.js';
import { Field } from '../fields.js';
import { useProject } from '../project-layout.js';

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
      <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-2">
        <Section title="Project members">
          <div className="-m-6">
            {members.map((member) => (
              <div
                key={member.id}
                className="flex items-center gap-3 border-b px-6 py-5 last:border-0"
              >
                <Person name={member.user.name} />
                <div className="min-w-0 flex-1">
                  <p
                    data-feedback-content
                    className="truncate text-xs font-medium"
                    title={member.user.name}
                  >
                    {member.user.name}
                  </p>
                  <p
                    data-feedback-content
                    className="mt-1 truncate text-[11px] text-muted-foreground"
                  >
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

export default function PeopleRoute() {
  const { project, refresh } = useProject();
  const query = useQuery({
    queryKey: ['members', project.id],
    queryFn: async ({ signal }) =>
      z
        .object({ members: memberListSchema })
        .parse(await request(`/api/projects/${project.id}/members`, { signal })).members,

    refetchInterval: 10_000,
  });
  useEffect(() => {
    if (query.error) toast.error(messageOf(query.error));
  }, [query.error]);
  return (
    <People key={project.id} project={project} members={query.data ?? []} onReload={refresh} />
  );
}
