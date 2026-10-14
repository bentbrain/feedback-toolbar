import { startTransition } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { HydratedRouter } from 'react-router/dom';
import { CSPProvider } from '@base-ui/react/csp-provider';

const nonce = document.querySelector('meta[name=csp-nonce]')?.getAttribute('content') ?? undefined;
startTransition(() => {
  hydrateRoot(
    document,
    <CSPProvider nonce={nonce}>
      <HydratedRouter />
    </CSPProvider>,
  );
});
