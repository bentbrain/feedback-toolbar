import type { FeedbackPin } from './pin-protocol.js';

const privateSelector =
  '[data-feedback-private],input,textarea,select,[contenteditable],[data-feedback-host]';

interface PinBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
  clipped: boolean;
}

function resolveAnchor(selector: string): Element | null {
  const matches = document.querySelectorAll(selector);
  const element = matches.length === 1 ? matches.item(0) : null;
  return element && !element.closest(privateSelector) ? element : null;
}

function paintContainment(style: CSSStyleDeclaration): boolean {
  return (
    style.contain.split(/\s+/).some((value) => ['paint', 'strict', 'content'].includes(value)) ||
    style.getPropertyValue('content-visibility') === 'auto'
  );
}

function unsupportedClip(style: CSSStyleDeclaration): boolean {
  // Paths and image masks may leave a positive box while hiding all its pixels.
  // Without a reliable rectangular bound, omit the pin on this box and descendants.
  const shape = [
    'clip-path',
    '-webkit-clip-path',
    'mask-image',
    '-webkit-mask-image',
    'mask-border-source',
    '-webkit-mask-box-image-source',
  ].some((property) => {
    const value = style.getPropertyValue(property);
    return value !== '' && !value.split(',').every((part) => part.trim() === 'none');
  });
  const clip = style.getPropertyValue('clip');
  return (
    shape ||
    ((style.position === 'absolute' || style.position === 'fixed') &&
      clip !== '' &&
      clip !== 'auto')
  );
}

function fixedContainingBlock(style: CSSStyleDeclaration): boolean {
  return (
    ['transform', 'translate', 'rotate', 'scale', 'perspective', 'filter'].some((property) => {
      const value = style.getPropertyValue(property);
      return value !== '' && value !== 'none';
    }) ||
    paintContainment(style) ||
    /(?:layout|paint|strict|content)/.test(style.contain) ||
    /(?:transform|translate|rotate|scale|perspective|filter)/.test(style.willChange)
  );
}

function clippedByAncestor(
  index: number,
  ancestors: { element: Element; style: CSSStyleDeclaration }[],
): boolean {
  for (let descendant = 0; descendant < index; descendant++) {
    const entry = ancestors[descendant];
    if (!entry) continue;
    let block: Element | null;
    if (entry.style.position === 'fixed') {
      block =
        ancestors.slice(descendant + 1).find((ancestor) => fixedContainingBlock(ancestor.style))
          ?.element ?? null;
    } else if (entry.style.position === 'absolute' && entry.element instanceof HTMLElement) {
      block = entry.element.offsetParent;
    } else continue;
    // Positioned boxes escape intermediate overflow clips until their containing
    // block. Viewport-fixed descendants escape them entirely without a local block.
    if (!block || ancestors.findIndex((ancestor) => ancestor.element === block) > index)
      return false;
  }
  return true;
}

function visibleBounds(
  element: Element,
  styles = new Map<Element, CSSStyleDeclaration>(),
  viewport = true,
): PinBounds | null {
  if (!element.isConnected || element.closest(privateSelector)) return null;
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  const bounds = {
    left: viewport ? Math.max(0, rect.left) : rect.left,
    top: viewport ? Math.max(0, rect.top) : rect.top,
    right: viewport ? Math.min(innerWidth, rect.right) : rect.right,
    bottom: viewport ? Math.min(innerHeight, rect.bottom) : rect.bottom,
    clipped: false,
  };
  const ancestors: { element: Element; style: CSSStyleDeclaration }[] = [];
  let complexTransform = false;
  for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
    let style = styles.get(ancestor);
    if (!style) {
      style = getComputedStyle(ancestor);
      styles.set(ancestor, style);
    }
    if (
      ancestor.hasAttribute('hidden') ||
      ancestor.hasAttribute('inert') ||
      ancestor.getAttribute('aria-hidden') === 'true' ||
      style.display === 'none' ||
      style.visibility !== 'visible' ||
      style.getPropertyValue('content-visibility') === 'hidden' ||
      unsupportedClip(style) ||
      Number(style.opacity) === 0
    )
      return null;
    if (style.transform !== 'none') {
      const transform = new DOMMatrixReadOnly(style.transform);
      if (
        !transform.is2D ||
        transform.b !== 0 ||
        transform.c !== 0 ||
        transform.a <= 0 ||
        transform.d <= 0
      )
        complexTransform = true;
    }
    const rotate = style.getPropertyValue('rotate');
    const scale = style.getPropertyValue('scale');
    if (
      (rotate && rotate !== 'none' && !/^0(?:deg|rad|turn)?$/.test(rotate)) ||
      (scale && scale !== 'none' && scale.split(/\s+/).some((value) => Number(value) <= 0))
    )
      complexTransform = true;
    ancestors.push({ element: ancestor, style });
  }
  for (let index = 1; index < ancestors.length; index++) {
    const ancestor = ancestors[index];
    if (!ancestor) continue;
    const paintClip = paintContainment(ancestor.style);
    const clipsX = paintClip || ancestor.style.overflowX !== 'visible';
    const clipsY = paintClip || ancestor.style.overflowY !== 'visible';
    if (
      (!clipsX && !clipsY) ||
      ancestor.style.display === 'inline' ||
      !clippedByAncestor(index, ancestors)
    )
      continue;
    // A rotated/skewed clip cannot be represented by a viewport rectangle safely.
    if (complexTransform || !(ancestor.element instanceof HTMLElement)) return null;
    const clip = ancestor.element.getBoundingClientRect();
    const scaleX = ancestor.element.offsetWidth > 0 ? clip.width / ancestor.element.offsetWidth : 1;
    const scaleY =
      ancestor.element.offsetHeight > 0 ? clip.height / ancestor.element.offsetHeight : 1;
    const left = clip.left + ancestor.element.clientLeft * scaleX;
    const top = clip.top + ancestor.element.clientTop * scaleY;
    // client dimensions include padding, exclude borders and scrollbars, and scale
    // into viewport coordinates along with translated/scaled clipping ancestors.
    if (clipsX) {
      bounds.left = Math.max(bounds.left, left);
      bounds.right = Math.min(bounds.right, left + ancestor.element.clientWidth * scaleX);
    }
    if (clipsY) {
      bounds.top = Math.max(bounds.top, top);
      bounds.bottom = Math.min(bounds.bottom, top + ancestor.element.clientHeight * scaleY);
    }
  }
  if (bounds.right <= bounds.left || bounds.bottom <= bounds.top) return null;
  bounds.clipped =
    bounds.left > rect.left ||
    bounds.top > rect.top ||
    bounds.right < rect.right ||
    bounds.bottom < rect.bottom;
  if (
    bounds.clipped &&
    (complexTransform || bounds.right - bounds.left < 32 || bounds.bottom - bounds.top < 32)
  )
    return null;
  return bounds;
}

export function publicAnchor(selector: string): Element | null {
  try {
    const element = resolveAnchor(selector);
    // The thread's Show element action can scroll an off-screen anchor into view.
    return element && visibleBounds(element, undefined, false) ? element : null;
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
  let anchors: (Element | null)[] = [];
  let motionFrame: number | undefined;
  let motionPoll: ReturnType<typeof setInterval> | undefined;
  const cssMotion = new Map<Element, Set<string>>();
  const browser: { getAnimations?: () => Animation[] } = document;
  let observed = new Set<Element>();
  const observer = new ResizeObserver(() => {
    schedule();
  });
  const paint = (resolve = true) => {
    if (destroyed) return;
    if (resolve) {
      const resolved = new Map<string, Element | null>();
      anchors = entries.map((entry) => {
        if (!resolved.has(entry.pin.selector)) {
          try {
            resolved.set(entry.pin.selector, resolveAnchor(entry.pin.selector));
          } catch {
            resolved.set(entry.pin.selector, null);
          }
        }
        return resolved.get(entry.pin.selector) ?? null;
      });
      const targets = new Set(anchors.filter((anchor) => anchor !== null));
      if (entries.length) targets.add(document.documentElement);
      for (const anchor of observed) if (!targets.has(anchor)) observer.unobserve(anchor);
      for (const anchor of targets) if (!observed.has(anchor)) observer.observe(anchor);
      observed = targets;
    }
    const styles = new Map<Element, CSSStyleDeclaration>();
    const bounds = new Map<Element, PinBounds | null>();
    const groups = new Map<Element, number[]>();
    anchors.forEach((anchor, index) => {
      if (!anchor) return;
      if (!bounds.has(anchor)) bounds.set(anchor, visibleBounds(anchor, styles));
      if (bounds.get(anchor)) groups.set(anchor, [...(groups.get(anchor) ?? []), index]);
    });
    entries.forEach(({ button }, index) => {
      const anchor = anchors[index];
      const group = anchor ? groups.get(anchor) : undefined;
      button.hidden = true;
      if (!anchor || !group) return;
      const rect = bounds.get(anchor);
      if (!rect) return;
      const offset = group.indexOf(index);
      const left = Math.max(8, rect.left);
      const top = Math.max(8, rect.top);
      const right = rect.clipped ? rect.right : innerWidth;
      const bottom = rect.clipped ? rect.bottom : innerHeight;
      const columns = Math.max(1, Math.floor((right - left + 4) / 36));
      const x = Math.min(innerWidth - 40, left) + (offset % columns) * 36;
      const y = top + Math.floor(offset / columns) * 36;
      if (x + 32 > right || y + 32 > bottom) return;
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
      detectMotion();
    }, 40);
  };
  const relevant = (target: Element) => anchors.some((anchor) => anchor && target.contains(anchor));
  const moving = () => {
    if (!browser.getAnimations) return [...cssMotion.keys()].some(relevant);
    return browser.getAnimations().some((animation) => {
      const effect = animation.effect;
      return (
        (animation.playState === 'running' || animation.pending) &&
        effect instanceof KeyframeEffect &&
        effect.target instanceof Element &&
        effect.getComputedTiming().progress !== null &&
        relevant(effect.target)
      );
    });
  };
  const sampleMotion = () => {
    motionFrame = undefined;
    if (destroyed || !entries.length) return;
    // Resolve selectors on mutations only; animation frames read cached anchors.
    paint(false);
    if (moving()) motionFrame = requestAnimationFrame(sampleMotion);
  };
  const detectMotion = () => {
    if (!destroyed && entries.length && motionFrame === undefined && moving())
      motionFrame = requestAnimationFrame(sampleMotion);
  };
  const motionEvent = (event: Event) => {
    if (!(event.target instanceof Element) || !entries.length || !relevant(event.target)) return;
    const key =
      event instanceof TransitionEvent
        ? `transition:${event.propertyName}`
        : event instanceof AnimationEvent
          ? `animation:${event.animationName}`
          : null;
    if (!key) return;
    const active = cssMotion.get(event.target) ?? new Set<string>();
    if (event.type.endsWith('end') || event.type.endsWith('cancel')) active.delete(key);
    else active.add(key);
    if (active.size) cssMotion.set(event.target, active);
    else cssMotion.delete(event.target);
    schedule();
    detectMotion();
  };
  const motionEvents = [
    'transitionrun',
    'transitionstart',
    'transitionend',
    'transitioncancel',
    'animationstart',
    'animationend',
    'animationcancel',
  ];
  const mutations = new MutationObserver(schedule);
  mutations.observe(document.documentElement, { subtree: true, childList: true, attributes: true });
  window.addEventListener('scroll', schedule, true);
  window.addEventListener('resize', schedule);
  document.addEventListener('load', schedule, true);
  for (const event of motionEvents) document.addEventListener(event, motionEvent, true);
  return {
    update(items: FeedbackPin[]) {
      if (destroyed) return;
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
          const anchor = current ? publicAnchor(current.pin.selector) : null;
          if (anchor && visibleBounds(anchor)) open(pin.threadId);
        });
        layer.append(button);
        return { pin, button };
      });
      for (const entry of old.values()) entry.button.remove();
      paint();
      if (entries.length) {
        // Script-created Web Animations have no CSS start event. Inspect the browser's
        // animation registry at low frequency, without querying selectors while idle.
        motionPoll ??= setInterval(detectMotion, 200);
        detectMotion();
      } else {
        clearInterval(motionPoll);
        motionPoll = undefined;
        if (motionFrame !== undefined) cancelAnimationFrame(motionFrame);
        motionFrame = undefined;
        cssMotion.clear();
      }
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
      clearInterval(motionPoll);
      if (motionFrame !== undefined) cancelAnimationFrame(motionFrame);
      cssMotion.clear();
      observer.disconnect();
      observed.clear();
      anchors = [];
      entries = [];
      mutations.disconnect();
      window.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
      document.removeEventListener('load', schedule, true);
      for (const event of motionEvents) document.removeEventListener(event, motionEvent, true);
      layer.remove();
      style.remove();
    },
  };
}
