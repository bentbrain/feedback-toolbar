import { publicAnchor } from './host-pins.js';
import type { FeedbackAnchors } from './pin-protocol.js';

// Match shared elements even when pins are switched off. Only selectors and IDs
// cross the frame boundary; the host never receives conversation content.
export function createHostAnchors(
  host: Element,
  pageUrl: () => string,
  send: (data: unknown) => void,
) {
  let candidates: FeedbackAnchors | null = null;
  let previous = '';
  let pending: ReturnType<typeof setTimeout> | undefined;
  const match = () => {
    pending = undefined;
    if (candidates?.url !== pageUrl()) return;
    const matches = new Map<string, boolean>();
    const threadIds = candidates.items
      .filter((item) => {
        if (!matches.has(item.selector))
          matches.set(item.selector, publicAnchor(item.selector) !== null);
        return matches.get(item.selector);
      })
      .map((item) => item.threadId);
    const signature = JSON.stringify([candidates.url, threadIds]);
    if (signature === previous) return;
    previous = signature;
    send({ type: 'feedback:anchors-found', url: candidates.url, threadIds });
  };
  const schedule = () => {
    if (candidates?.items.length && pending === undefined) pending = setTimeout(match, 50);
  };
  const observer = new MutationObserver((records) => {
    if (records.some((record) => record.target !== host && !host.contains(record.target)))
      schedule();
  });
  window.addEventListener('resize', schedule);
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
  });
  return {
    update(value: FeedbackAnchors | null) {
      clearTimeout(pending);
      candidates = value;
      previous = '';
      match();
    },
    destroy() {
      observer.disconnect();
      clearTimeout(pending);
      window.removeEventListener('resize', schedule);
    },
  };
}
