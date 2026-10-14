import { createHostPins, publicAnchor } from './host-pins.js';
import { boundedMessage, feedbackPins } from './pin-protocol.js';

export interface FeedbackOptions {
  server: string;
  projectId: string;
  theme?: {
    mode?: 'light' | 'dark' | 'system';
    accent?: string;
    radius?: 'square' | 'soft' | 'round';
    density?: 'comfortable' | 'compact';
    placement?: 'bottom-right' | 'bottom-left';
  };
  deployment?: string;
}
type JsonObject = Record<string, unknown>;
function record(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function sanitizeText(element: Element): string {
  if (element.closest('[data-feedback-private], input, textarea, select, [contenteditable]'))
    return '[Private element]';
  const clone = element.cloneNode(true);
  if (!(clone instanceof Element)) return '';
  clone
    .querySelectorAll(
      'input,textarea,select,script,style,[data-feedback-private],[contenteditable]',
    )
    .forEach((node) => {
      node.remove();
    });
  return clone.textContent.replace(/\s+/g, ' ').trim().slice(0, 300);
}
function selectorFor(element: Element): string {
  const stable = element.getAttribute('data-feedback-id');
  if (stable) return `[data-feedback-id="${CSS.escape(stable)}"]`;
  if (element.id) return `#${CSS.escape(element.id)}`;
  const parts: string[] = [];
  let current: Element | null = element;
  while (current && parts.length < 6 && current !== document.documentElement) {
    const tag = current.tagName.toLowerCase();
    const stableAncestor = current.getAttribute('data-feedback-id');
    if (stableAncestor || current.id) {
      parts.unshift(
        stableAncestor
          ? `[data-feedback-id="${CSS.escape(stableAncestor)}"]`
          : `#${CSS.escape(current.id)}`,
      );
      break;
    }
    const parent: Element | null = current.parentElement;
    const siblings = parent
      ? Array.from(parent.children).filter((child) => child.tagName === current?.tagName)
      : [];
    const index = siblings.indexOf(current) + 1;
    parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${index})` : tag);
    current = parent;
  }
  return parts.join(' > ').slice(0, 700);
}

export function mountFeedback(options: FeedbackOptions): { destroy(): void } {
  const service = new URL(options.server);
  if (
    !['http:', 'https:'].includes(service.protocol) ||
    service.username ||
    service.password ||
    service.origin === location.origin
  )
    throw new Error('Serve the feedback toolbar from a separate http(s) origin.');
  if (
    service.protocol === 'http:' &&
    !['localhost', '127.0.0.1', '[::1]'].includes(service.hostname)
  )
    throw new Error('The feedback service must use HTTPS.');
  if (document.querySelector('[data-feedback-host]'))
    throw new Error('A feedback toolbar is already mounted.');
  const host = document.createElement('div');
  host.setAttribute('data-feedback-host', options.projectId);
  const critical = {
    all: 'initial',
    position: 'fixed',
    bottom: '20px',
    right: '20px',
    left: 'auto',
    width: '248px',
    height: '56px',
    'z-index': '2147483647',
    display: 'none',
    margin: '0',
    padding: '0',
    border: '0',
    transform: 'none',
    isolation: 'isolate',
    overflow: 'visible',
  };
  for (const [key, value] of Object.entries(critical))
    host.style.setProperty(key, value, 'important');
  const shadow = host.attachShadow({ mode: 'closed' });
  const frame = document.createElement('iframe');
  frame.title = 'Website feedback toolbar';
  frame.setAttribute(
    'sandbox',
    'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox',
  );
  frame.referrerPolicy = 'no-referrer';
  frame.style.cssText =
    'display:block;position:relative;z-index:2;width:100%;height:100%;border:0;background:transparent;color-scheme:light dark;';
  const frameUrl = new URL('/toolbar', service);
  frameUrl.searchParams.set('project', options.projectId);
  frameUrl.searchParams.set('origin', location.origin);
  if (location.hash === '#feedback-connect') {
    frameUrl.searchParams.set('connect', '1');
    history.replaceState(history.state, '', `${location.pathname}${location.search}`);
  }
  frame.src = frameUrl.toString();
  shadow.append(frame);
  document.documentElement.append(host);
  const highlight = document.createElement('div');
  highlight.style.cssText =
    'position:fixed;pointer-events:none;border:2px solid #e66b42;background:rgba(230,107,66,.08);border-radius:4px;display:none;box-sizing:border-box;';
  shadow.append(highlight);
  let selecting = false;
  let marked: Element | null = null;
  let placement = options.theme?.placement ?? 'bottom-right';
  const send = (data: unknown) => frame.contentWindow?.postMessage(data, service.origin);
  const pageUrl = () => `${location.origin}${location.pathname}`;
  let pinsPage = '';
  let visible = false;
  const pins = createHostPins(shadow, (threadId) => {
    if (!visible || pinsPage !== pageUrl()) return;
    stopSelection();
    marked = null;
    paint();
    send({ type: 'feedback:open-thread', threadId, url: pinsPage });
  });
  const clearPins = () => {
    pinsPage = '';
    pins.update([]);
  };
  const media = matchMedia('(prefers-color-scheme: dark)');
  const systemMode = () => (media.matches ? 'dark' : 'light');
  const onSystemTheme = () => send({ type: 'feedback:system-theme', systemMode: systemMode() });
  const resize = (width: number, height: number) => {
    host.style.setProperty('width', `${Math.min(width, innerWidth - 24)}px`, 'important');
    host.style.setProperty('height', `${Math.min(height, innerHeight - 36)}px`, 'important');
    host.style.setProperty('right', placement === 'bottom-right' ? '16px' : 'auto', 'important');
    host.style.setProperty('left', placement === 'bottom-left' ? '16px' : 'auto', 'important');
  };
  let size = { width: 248, height: 56 };
  const paint = () => {
    if (!marked?.isConnected) {
      highlight.style.display = 'none';
      return;
    }
    const rect = marked.getBoundingClientRect();
    const box = host.getBoundingClientRect();
    highlight.style.display = 'block';
    highlight.style.left = `${rect.left - box.left}px`;
    highlight.style.top = `${rect.top - box.top}px`;
    highlight.style.width = `${rect.width}px`;
    highlight.style.height = `${rect.height}px`;
    // The overlay sits in the shadow root but its fixed coordinates are viewport-relative.
    highlight.style.left = `${rect.left}px`;
    highlight.style.top = `${rect.top}px`;
  };
  const onMove = (event: PointerEvent) => {
    if (!selecting || event.composedPath().includes(host)) return;
    if (event.target instanceof Element && !event.target.closest('[data-feedback-private]')) {
      marked = event.target;
      paint();
    }
  };
  const contextFor = (element: Element) => {
    const rect = element.getBoundingClientRect();
    const page = new URL(location.href);
    page.search = '';
    page.hash = '';
    return {
      url: page.toString(),
      viewport: { width: innerWidth, height: innerHeight },
      deployment: options.deployment ?? null,
      anchor: {
        selector: selectorFor(element),
        feedbackId: element.getAttribute('data-feedback-id')?.slice(0, 120) ?? null,
        tag: element.tagName.toLowerCase().slice(0, 40),
        text: sanitizeText(element),
        label: (element.getAttribute('aria-label') ?? '').slice(0, 200),
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      },
    };
  };
  const stopSelection = () => {
    selecting = false;
    document.documentElement.style.removeProperty('cursor');
  };
  const onClick = (event: MouseEvent) => {
    if (!selecting || event.composedPath().includes(host)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!(event.target instanceof Element) || event.target.closest('[data-feedback-private]'))
      return;
    marked = event.target;
    stopSelection();
    paint();
    send({ type: 'feedback:selected', context: contextFor(marked) });
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && selecting) {
      stopSelection();
      marked = null;
      paint();
      send({ type: 'feedback:selection-cancelled' });
    }
  };
  const onMessage = (event: MessageEvent<unknown>) => {
    if (
      event.origin !== service.origin ||
      event.source !== frame.contentWindow ||
      !record(event.data) ||
      !boundedMessage(event.data)
    )
      return;
    const data = event.data;
    if (feedbackPins(data)) {
      if (visible && data.url === pageUrl()) {
        pinsPage = data.url;
        pins.update(data.items);
      }
      return;
    }
    if (data.type === 'feedback:visibility' && typeof data.visible === 'boolean') {
      visible = data.visible;
      host.style.setProperty('display', data.visible ? 'block' : 'none', 'important');
      if (!data.visible) {
        clearPins();
        stopSelection();
        marked = null;
        paint();
      }
    }
    if (data.type === 'feedback:ready')
      send({
        type: 'feedback:configure',
        systemMode: systemMode(),
        projectId: options.projectId,
        theme: options.theme ?? {},
        url: pageUrl(),
        viewport: { width: innerWidth, height: innerHeight },
      });
    if (
      data.type === 'feedback:resize' &&
      typeof data.width === 'number' &&
      typeof data.height === 'number' &&
      Number.isFinite(data.width) &&
      Number.isFinite(data.height)
    ) {
      size = {
        width: Math.max(56, Math.min(data.width, 440)),
        height: Math.max(48, Math.min(data.height, 760)),
      };
      resize(size.width, size.height);
    }
    if (
      data.type === 'feedback:theme' &&
      typeof data.accent === 'string' &&
      /^#[\da-fA-F]{6}$/.test(data.accent)
    ) {
      highlight.style.borderColor = data.accent;
      highlight.style.background = `${data.accent}14`;
      if (
        (data.mode === 'light' || data.mode === 'dark') &&
        (data.radius === 'square' || data.radius === 'soft' || data.radius === 'round')
      )
        pins.theme(data.accent, data.mode, data.radius);
      if (data.placement === 'bottom-left' || data.placement === 'bottom-right') {
        placement = data.placement;
        resize(size.width, size.height);
      }
    }
    if (data.type === 'feedback:select') {
      selecting = true;
      document.documentElement.style.setProperty('cursor', 'crosshair', 'important');
    }
    if (data.type === 'feedback:clear') {
      stopSelection();
      marked = null;
      paint();
    }
    if (
      data.type === 'feedback:highlight' &&
      typeof data.selector === 'string' &&
      data.selector.length <= 700
    ) {
      try {
        marked = publicAnchor(data.selector);
        if (marked) marked.scrollIntoView({ block: 'center', behavior: 'smooth' });
        paint();
        send({ type: 'feedback:anchor-status', found: marked !== null });
      } catch {
        send({ type: 'feedback:anchor-status', found: false });
      }
    }
  };
  const updateViewport = () => {
    if (location.hash === '#feedback-connect') {
      history.replaceState(history.state, '', `${location.pathname}${location.search}`);
      send({ type: 'feedback:connect' });
    }
    resize(size.width, size.height);
    paint();
    if (pinsPage && pinsPage !== pageUrl()) clearPins();
    if (previousPage !== pageUrl()) {
      previousPage = pageUrl();
      stopSelection();
      marked = null;
      paint();
      send({
        type: 'feedback:navigation',
        url: pageUrl(),
        viewport: { width: innerWidth, height: innerHeight },
      });
    }
  };
  let previousPage = pageUrl();
  let previousUrl = location.href;
  const navigation = setInterval(() => {
    if (previousUrl !== location.href) {
      previousUrl = location.href;
      updateViewport();
    }
  }, 800);
  media.addEventListener('change', onSystemTheme);
  window.addEventListener('message', onMessage);
  document.addEventListener('pointermove', onMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('scroll', paint, true);
  window.addEventListener('resize', updateViewport);
  return {
    destroy() {
      clearInterval(navigation);
      pins.destroy();
      stopSelection();
      host.remove();
      media.removeEventListener('change', onSystemTheme);
      window.removeEventListener('message', onMessage);
      document.removeEventListener('pointermove', onMove, true);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', paint, true);
      window.removeEventListener('resize', updateViewport);
    },
  };
}
