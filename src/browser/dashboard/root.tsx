import type { ReactNode } from 'react';
import {
  isRouteErrorResponse,
  Links,
  Meta,
  Scripts,
  ScrollRestoration,
  useRouteError,
} from 'react-router';
import { Loader2 } from 'lucide-react';
import { Empty } from '../components/common.js';
import { SessionBoundary } from './session.js';
import styles from './dashboard.css?url';

export function links() {
  return [{ rel: 'stylesheet', href: styles }];
}
export function Layout({ children }: { children: ReactNode }) {
  const nonce =
    typeof document === 'undefined'
      ? '__FEEDBACK_NONCE__'
      : (document.querySelector('meta[name=csp-nonce]')?.getAttribute('content') ??
        '__FEEDBACK_NONCE__');
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="csp-nonce" content={nonce} />
        <title>Feedback</title>
        <link rel="icon" href="/icon.svg" type="image/svg+xml" />
        <Meta />
        <Links />
      </head>
      <body>
        <div id="app">{children}</div>
        <ScrollRestoration nonce={nonce} />
        <Scripts nonce={nonce} />
      </body>
    </html>
  );
}
export function HydrateFallback() {
  return <Empty title="Loading…" symbol={<Loader2 className="animate-spin" />} />;
}
export function ErrorBoundary() {
  const error = useRouteError();
  const description = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : 'Please reload the page and try again.';
  return <Empty title="Couldn't open Feedback." description={description} />;
}
export default function Root() {
  return <SessionBoundary />;
}
