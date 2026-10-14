import { useCallback, useEffect, useState } from 'react';
import { z } from 'zod';
import { toast } from 'sonner';
import { messageOf, request } from '../../ui.js';
import { Button } from '../../components/ui/button.js';
import { PageHeading, Section } from '../../components/common.js';

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

export default function AccountSecurity() {
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
