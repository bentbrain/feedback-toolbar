import { mountFeedback } from './loader.js';

const current = document.currentScript;
if (current instanceof HTMLScriptElement) {
  const projectId = current.dataset.project;
  if (projectId) {
    const run = () =>
      mountFeedback({
        server: new URL(current.src).origin,
        projectId,
        ...(current.dataset.deployment ? { deployment: current.dataset.deployment } : {}),
        theme: {
          ...(current.dataset.mode === 'light' ||
          current.dataset.mode === 'dark' ||
          current.dataset.mode === 'system'
            ? { mode: current.dataset.mode }
            : {}),
          ...(current.dataset.accent ? { accent: current.dataset.accent } : {}),
          ...(current.dataset.placement === 'bottom-left' ||
          current.dataset.placement === 'bottom-right'
            ? { placement: current.dataset.placement }
            : {}),
        },
      });
    if (document.readyState === 'loading')
      document.addEventListener('DOMContentLoaded', run, { once: true });
    else run();
  } else console.warn('[feedback-toolbar] Add data-project to the embed script.');
}
