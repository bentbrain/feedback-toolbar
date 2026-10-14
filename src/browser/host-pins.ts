import type { FeedbackPin } from './pin-protocol.js';

const privateSelector =
  '[data-feedback-private],input,textarea,select,[contenteditable],[data-feedback-host]';

export function publicAnchor(selector: string): Element | null {
  try {
    const matches = document.querySelectorAll(selector);
    const element = matches.length === 1 ? matches.item(0) : null;
    if (!element || element.closest(privateSelector)) return null;
    for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      if (
        ancestor.hasAttribute('hidden') ||
        ancestor.hasAttribute('inert') ||
        ancestor.getAttribute('aria-hidden') === 'true' ||
        style.display === 'none' ||
        style.visibility !== 'visible' ||
        Number(style.opacity) === 0
      )
        return null;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 ? element : null;
  } catch {
    return null;
  }
}

// The host embed is deliberately framework-free. These native controls use the
// toolbar's theme variables inside its closed shadow root, with no asset requests.
export function createHostPins(shadow: ShadowRoot, open: (threadId: string) => void) {
  const style = document.createElement('style');
  style.textContent = `
    .feedback-pins { position:fixed; inset:0; pointer-events:none; z-index:1;
      --primary:#0647ff; --background:#fff; --ring:var(--primary); --radius:0px; }
    .feedback-pin { all:initial; box-sizing:border-box; position:fixed; display:flex;
      align-items:center; justify-content:center; width:32px; height:32px;
      border:2px solid var(--primary); border-radius:var(--radius);
      background:var(--background); color:var(--primary); cursor:pointer;
      font:600 12px/1 ui-monospace,monospace; pointer-events:auto;
      box-shadow:0 2px 6px #0003; }
    .feedback-pin[hidden] { display:none; }
    .feedback-pin:hover { box-shadow:0 0 0 2px var(--background),0 0 0 3px var(--ring); }
    .feedback-pin:focus-visible { outline:3px solid var(--ring); outline-offset:3px; }
  `;
  const layer = document.createElement('div');
  layer.className = 'feedback-pins';
  layer.setAttribute('role', 'group');
  layer.setAttribute('aria-label', 'Feedback pins');
  shadow.append(style, layer);
  let entries: { pin: FeedbackPin; button: HTMLButtonElement }[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let destroyed = false;
  let observed = new Set<Element>();
  const observer = new ResizeObserver(() => {
    schedule();
  });
  const paint = () => {
    const resolved = new Map<string, Element | null>();
    const anchors = entries.map((entry) => {
      if (!resolved.has(entry.pin.selector))
        resolved.set(entry.pin.selector, publicAnchor(entry.pin.selector));
      return resolved.get(entry.pin.selector) ?? null;
    });
    const groups = new Map<Element, number[]>();
    anchors.forEach((anchor, index) => {
      if (anchor) groups.set(anchor, [...(groups.get(anchor) ?? []), index]);
    });
    const targets = new Set(groups.keys());
    if (entries.length) targets.add(document.documentElement);
    for (const anchor of observed) if (!targets.has(anchor)) observer.unobserve(anchor);
    for (const anchor of targets) if (!observed.has(anchor)) observer.observe(anchor);
    observed = targets;
    entries.forEach(({ button }, index) => {
      const anchor = anchors[index];
      const group = anchor ? groups.get(anchor) : undefined;
      button.hidden = true;
      if (!anchor || !group) return;
      const rect = anchor.getBoundingClientRect();
      if (rect.bottom <= 0 || rect.top >= innerHeight || rect.right <= 0 || rect.left >= innerWidth)
        return;
      const offset = group.indexOf(index);
      const columns = Math.max(1, Math.floor((innerWidth - Math.max(8, rect.left)) / 36));
      const x = Math.min(innerWidth - 40, Math.max(8, rect.left)) + (offset % columns) * 36;
      const y = Math.max(8, rect.top) + Math.floor(offset / columns) * 36;
      if (x + 32 > innerWidth || y + 32 > innerHeight) return;
      button.style.left = `${x}px`;
      button.style.top = `${y}px`;
      button.setAttribute(
        'aria-label',
        `Open feedback ${index + 1}${group.length > 1 ? `, ${offset + 1} of ${group.length} on this element` : ''}`,
      );
      button.hidden = false;
    });
  };
  const schedule = () => {
    if (destroyed || !entries.length || timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      paint();
    }, 40);
  };
  const mutations = new MutationObserver(schedule);
  mutations.observe(document.documentElement, { subtree: true, childList: true, attributes: true });
  window.addEventListener('scroll', schedule, true);
  window.addEventListener('resize', schedule);
  document.addEventListener('load', schedule, true);
  document.addEventListener('transitionend', schedule, true);
  document.addEventListener('animationend', schedule, true);
  return {
    update(items: FeedbackPin[]) {
      const old = new Map(entries.map((entry) => [entry.pin.threadId, entry]));
      entries = items.map((pin, index) => {
        const previous = old.get(pin.threadId);
        if (previous) {
          old.delete(pin.threadId);
          previous.pin = pin;
          previous.button.textContent = String(index + 1);
          return previous;
        }
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'feedback-pin';
        button.textContent = String(index + 1);
        button.hidden = true;
        button.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          // Resolve again at activation; mutations may precede the debounced paint.
          const current = entries.find((entry) => entry.pin.threadId === pin.threadId);
          if (current && publicAnchor(current.pin.selector)) open(pin.threadId);
        });
        layer.append(button);
        return { pin, button };
      });
      for (const entry of old.values()) entry.button.remove();
      paint();
    },
    theme(accent: string, mode: string, radius: string) {
      layer.style.setProperty('--primary', accent);
      layer.style.setProperty('--background', mode === 'dark' ? '#000' : '#fff');
      layer.style.setProperty(
        '--radius',
        radius === 'round' ? '16px' : radius === 'soft' ? '8px' : '0px',
      );
    },
    destroy() {
      destroyed = true;
      clearTimeout(timer);
      observer.disconnect();
      mutations.disconnect();
      window.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
      document.removeEventListener('load', schedule, true);
      document.removeEventListener('transitionend', schedule, true);
      document.removeEventListener('animationend', schedule, true);
      layer.remove();
      style.remove();
    },
  };
}
