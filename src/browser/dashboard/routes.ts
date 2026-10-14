import { index, layout, route } from '@react-router/dev/routes';
import type { RouteConfig } from '@react-router/dev/routes';

export default [
  layout('layout.tsx', [
    layout('project-layout.tsx', [
      index('routes/feedback.tsx'),
      route('feedback', 'routes/feedback.tsx', { id: 'feedback' }),
      route('install', 'routes/install.tsx'),
      route('appearance', 'routes/appearance.tsx'),
      route('people', 'routes/people.tsx'),
      route('agents', 'routes/agents.tsx'),
    ]),
    route('account', 'routes/account.tsx'),
    route('auth', 'routes/auth.tsx'),
  ]),
] satisfies RouteConfig;
