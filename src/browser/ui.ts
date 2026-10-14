import { z } from 'zod';
import type { Theme } from '../shared/models.js';
export function rootElement(): HTMLElement {
  const element = document.getElementById('app');
  if (!element) throw new Error('Application root is missing.');
  return element;
}
export async function request(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    token?: string;
    headers?: Record<string, string>;
  } = {},
): Promise<unknown> {
  if (!path.startsWith('/api/') || /[\\#]/.test(path)) throw new Error('Use a feedback API path.');
  const endpoint = new URL(path, location.origin);
  if (
    endpoint.origin !== location.origin ||
    !/^\/api\/[A-Za-z0-9_/-]+$/.test(endpoint.pathname) ||
    /%|\.\./.test(path.split('?')[0] ?? '')
  )
    throw new Error('Invalid feedback API path.');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...options.headers,
  };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  const response = await fetch(endpoint.href, {
    method: options.method ?? 'GET',
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    credentials: options.token ? 'omit' : 'same-origin',
    redirect: 'error',
  });
  const data: unknown = await response.json();
  if (!response.ok) {
    const error = z.object({ error: z.string() }).safeParse(data);
    throw new Error(error.success ? error.data.error : `Request failed (${response.status}).`);
  }
  return data;
}
export const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : 'Something went wrong.';
export function applyTheme(theme: Theme, element: HTMLElement = document.documentElement): void {
  const resolved =
    theme.mode === 'system'
      ? matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : theme.mode;
  element.dataset.mode = resolved;
  element.classList.toggle('dark', resolved === 'dark');
  element.dataset.density = theme.density;
  const accent =
    resolved === 'dark' && theme.accent.toLowerCase() === '#0647ff' ? '#2870ff' : theme.accent;
  element.style.setProperty('--primary', accent);
  const foreground =
    theme.accent.toLowerCase() === '#0647ff' ? accent : resolved === 'dark' ? '#f5f5f5' : '#171717';
  for (const property of [
    '--foreground',
    '--card-foreground',
    '--popover-foreground',
    '--secondary-foreground',
    '--accent-foreground',
  ])
    element.style.setProperty(property, foreground);
  for (const property of ['--border', '--input', '--ring'])
    element.style.setProperty(property, accent);
  const rgb = accent.match(/[a-fA-F\d]{2}/g)?.map((value) => Number.parseInt(value, 16)) ?? [
    0, 0, 0,
  ];
  const luminance = rgb.reduce((sum, channel, index) => {
    const value = channel / 255;
    const linear = value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    return sum + linear * ([0.2126, 0.7152, 0.0722][index] ?? 0);
  }, 0);
  element.style.setProperty(
    '--primary-foreground',
    luminance > Math.sqrt(0.05 * 1.05) - 0.05 ? '#000000' : '#ffffff',
  );
  element.style.setProperty(
    '--radius',
    theme.radius === 'square' ? '0px' : theme.radius === 'round' ? '16px' : '10px',
  );
}
export function relativeTime(value: string): string {
  const minutes = Math.floor((Date.now() - new Date(value).getTime()) / 60_000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  return new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
export function initials(name: string): string {
  return name
    .split(' ')
    .map((part) => part[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
}
export function formInput(form: HTMLFormElement, name: string): string {
  const value = new FormData(form).get(name);
  return typeof value === 'string' ? value : '';
}
