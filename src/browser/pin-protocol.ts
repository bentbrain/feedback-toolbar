export const maxPins = 256;
export interface FeedbackPin {
  threadId: string;
  selector: string;
}
export interface FeedbackPins {
  type: 'feedback:pins';
  url: string;
  items: FeedbackPin[];
}
export interface FeedbackAnchors {
  type: 'feedback:anchors';
  url: string;
  items: FeedbackPin[];
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Bound traversal before parsing either side of the iframe protocol. Structured-cloned
// values still need limits on nesting, fields, strings, and total work.
export function boundedMessage(value: unknown): boolean {
  let remaining = 240_000;
  let nodes = 5000;
  const visit = (item: unknown, depth: number): boolean => {
    if (--nodes < 0 || depth > 8) return false;
    if (typeof item === 'string') {
      remaining -= item.length;
      return item.length <= 9000 && remaining >= 0;
    }
    if (item === null || typeof item === 'boolean') return true;
    if (typeof item === 'number') return Number.isFinite(item);
    if (Array.isArray(item))
      return item.length <= maxPins && item.every((entry: unknown) => visit(entry, depth + 1));
    if (!object(item)) return false;
    const keys = Object.keys(item);
    return (
      keys.length <= 40 && keys.every((key) => key.length <= 80 && visit(item[key], depth + 1))
    );
  };
  return object(value) && visit(value, 0);
}

function pin(value: unknown): value is FeedbackPin {
  return (
    object(value) &&
    Object.keys(value).length === 2 &&
    typeof value.threadId === 'string' &&
    /^[\w-]{1,120}$/.test(value.threadId) &&
    typeof value.selector === 'string' &&
    value.selector.length > 0 &&
    value.selector.length <= 700
  );
}

export function feedbackPins(value: unknown): value is FeedbackPins {
  return (
    object(value) &&
    Object.keys(value).length === 3 &&
    value.type === 'feedback:pins' &&
    typeof value.url === 'string' &&
    value.url.length <= 1500 &&
    Array.isArray(value.items) &&
    value.items.length <= maxPins &&
    value.items.every((item: unknown) => pin(item)) &&
    new Set(value.items.map((item: FeedbackPin) => item.threadId)).size === value.items.length
  );
}

export function feedbackAnchors(value: unknown): value is FeedbackAnchors {
  return (
    object(value) &&
    value.type === 'feedback:anchors' &&
    feedbackPins({ ...value, type: 'feedback:pins' })
  );
}
