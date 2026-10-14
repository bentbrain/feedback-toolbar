import type { Frame, Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { projectSchema, threadSchema } from '../src/shared/models.js';
import { test, expect } from './pins.fixtures.js';

const website = 'http://localhost:44331';

async function instrument(page: Page) {
  await page.addInitScript(() => {
    let root: ShadowRoot | null = null;
    const messages: unknown[] = [];
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'attachShadow');
    if (!descriptor) throw new Error('Shadow root method missing');
    const prototype: unknown = Object.create(Element.prototype, { attachShadow: descriptor });
    if (!(prototype instanceof Element)) throw new Error('Element prototype missing');
    const originalAttach = (element: Element, options: ShadowRootInit) =>
      prototype.attachShadow.call(element, options);
    Element.prototype.attachShadow = function (options) {
      const result = originalAttach(this, options);
      if (this.hasAttribute('data-feedback-host')) root = result;
      return result;
    };
    // Test-only access keeps the real root closed, including its event retargeting.
    Object.defineProperty(window, 'pinTestRoot', { get: () => root });
    Object.defineProperty(window, 'pinTestMessages', { get: () => messages });
    window.addEventListener('message', (event: MessageEvent<unknown>) => {
      messages.push(event.data);
    });
  });
}

async function createProject(page: Page) {
  expect(
    (
      await page.request.post('/api/auth/sign-up/email', {
        data: {
          name: 'Pin reviewer',
          email: `${randomUUID()}@example.invalid`,
          password: randomUUID(),
        },
      })
    ).status(),
  ).toBe(200);
  const result = await page.request.post('/api/projects', {
    data: {
      name: 'Pins',
      origins: [website],
      theme: { mode: 'dark', accent: '#788468', radius: 'soft' },
    },
  });
  expect(result.status()).toBe(201);
  return z.object({ project: projectSchema }).parse(await result.json()).project;
}

async function createThread(
  page: Page,
  projectId: string,
  selector: string,
  body: string,
  url = `${website}/`,
) {
  const result = await page.request.post(`/api/projects/${projectId}/threads`, {
    data: {
      body,
      context: {
        url,
        viewport: { width: 1280, height: 800 },
        deployment: null,
        anchor: {
          selector,
          feedbackId: null,
          tag: 'button',
          text: 'Private thread context',
          label: 'Private thread label',
          rect: { x: 0, y: 0, width: 100, height: 30 },
        },
      },
    },
  });
  expect(result.status()).toBe(201);
  return z.object({ thread: threadSchema }).parse(await result.json()).thread;
}

async function openToolbar(page: Page, projectId: string): Promise<Frame> {
  await page.goto(`${website}/?project=${projectId}`);
  await expect(page.locator('[data-feedback-host]')).toBeVisible({ timeout: 15_000 });
  const frame = page.frames().find((frame) => frame.url().includes('/toolbar?'));
  if (!frame) throw new Error('Toolbar frame missing');
  await expect(
    frame.getByRole('switch', { name: 'Show feedback pins', exact: true }),
  ).toBeEnabled();
  return frame;
}

async function pins(page: Page) {
  return page.evaluate(() => {
    const root: unknown = Reflect.get(window, 'pinTestRoot');
    if (!(root instanceof ShadowRoot)) throw new Error('Closed test root missing');
    return Array.from(root.querySelectorAll('button')).flatMap((button) => {
      const rect = button.getBoundingClientRect();
      const style = getComputedStyle(button);
      if (button.hidden || rect.width === 0 || rect.height === 0) return [];
      return [
        {
          label: button.getAttribute('aria-label'),
          text: button.textContent,
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          focused: root.activeElement === button,
          outline: style.outlineStyle,
          background: style.backgroundColor,
          color: style.color,
          radius: style.borderRadius,
        },
      ];
    });
  });
}

async function clickPin(page: Page, number: number) {
  const pin = (await pins(page)).find((pin) => pin.text === String(number));
  if (!pin) throw new Error(`Pin ${number} missing`);
  await page.mouse.click(pin.x + pin.width / 2, pin.y + pin.height / 2);
}

async function pinMessages(page: Page) {
  const values: unknown = await page.evaluate(() => {
    const messages: unknown = Reflect.get(window, 'pinTestMessages');
    return messages;
  });
  return z
    .array(z.unknown())
    .parse(values)
    .flatMap((value) => {
      const result = z
        .object({
          type: z.literal('feedback:pins'),
          url: z.string(),
          items: z.array(z.object({ threadId: z.string(), selector: z.string() }).strict()),
        })
        .strict()
        .safeParse(value);
      return result.success ? [result.data] : [];
    });
}

test('toggle renders isolated accessible pins and click or keyboard opens the matching thread in place', async ({
  page,
}) => {
  await instrument(page);
  const project = await createProject(page);
  const first = await createThread(
    page,
    project.id,
    '[data-feedback-id="hero-button"]',
    'First button feedback',
  );
  const second = await createThread(
    page,
    project.id,
    '[data-feedback-id="hero-button"]',
    'Second button feedback',
  );
  const frame = await openToolbar(page, project.id);
  expect(await pins(page)).toEqual([]);
  await frame.getByRole('switch', { name: 'Show feedback pins', exact: true }).click();
  await expect(frame.getByRole('switch', { name: 'Hide feedback pins' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect.poll(async () => (await pins(page)).length).toBe(2);
  const visible = await pins(page);
  expect(visible.map((pin) => pin.label)).toEqual([
    'Open feedback 1, 1 of 2 on this element',
    'Open feedback 2, 2 of 2 on this element',
  ]);
  expect(visible[0]?.x).not.toBe(visible[1]?.x);
  expect(visible[0]).toMatchObject({
    background: 'rgb(0, 0, 0)',
    color: 'rgb(120, 132, 104)',
    radius: '8px',
  });
  await page.addStyleTag({
    content:
      '* { color:red !important } [data-feedback-host] button { font-size:64px !important; display:none !important }',
  });
  expect((await pins(page))[0]?.width).toBe(32);
  expect((await pins(page))[0]?.color).toBe('rgb(120, 132, 104)');
  expect(await page.locator('[data-feedback-host]').evaluate((host) => host.shadowRoot)).toBeNull();
  const metadata = (await pinMessages(page)).at(-1);
  expect(metadata?.items.map((item) => item.threadId)).toEqual([second.id, first.id]);
  const startScroll = await page.evaluate(() => scrollY);
  await clickPin(page, 1);
  await expect(frame.getByText('Second button feedback', { exact: true })).toBeVisible();
  await expect(frame.getByRole('button', { name: 'New feedback', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => scrollY)).toBe(startScroll);
  await frame.getByRole('button', { name: 'Minimize toolbar' }).click();
  await clickPin(page, 2);
  await expect(frame.getByText('First button feedback', { exact: true })).toBeVisible();
  await page.keyboard.press('Tab');
  // Tab from the host document reaches native controls outside the iframe.
  await page.mouse.click(20, 20);
  for (let count = 0; count < 30 && !(await pins(page)).some((pin) => pin.focused); count++)
    await page.keyboard.press('Tab');
  const focused = (await pins(page)).find((pin) => pin.focused);
  expect(focused?.outline).toBe('solid');
  await page.keyboard.press('Enter');
  await expect(
    frame.getByText(focused?.text === '1' ? 'Second button feedback' : 'First button feedback', {
      exact: true,
    }),
  ).toBeVisible();
  await frame.getByRole('switch', { name: 'Hide feedback pins', exact: true }).click();
  await expect.poll(async () => (await pins(page)).length).toBe(0);
});

test('pins follow scroll, reflow and resize, reject missing, duplicate and private anchors, and reset on navigation', async ({
  page,
}) => {
  await instrument(page);
  const project = await createProject(page);
  await createThread(page, project.id, '[data-feedback-id="hero-heading"]', 'Heading feedback');
  await createThread(page, project.id, '#missing', 'Missing feedback');
  await createThread(page, project.id, '', 'Unanchored feedback');
  await createThread(page, project.id, 'button', 'Ambiguous feedback');
  await createThread(page, project.id, '.feedback-form input', 'Private feedback');
  await createThread(page, project.id, 'main', 'Different page feedback', `${website}/other`);
  const frame = await openToolbar(page, project.id);
  await frame.getByRole('switch', { name: 'Show feedback pins', exact: true }).click();
  await expect.poll(async () => (await pins(page)).length).toBe(1);
  const original = (await pins(page))[0];
  if (!original) throw new Error('Heading pin missing');
  await page.evaluate(() => {
    scrollBy(0, 80);
  });
  await expect.poll(async () => (await pins(page))[0]?.y).toBeCloseTo(original.y - 80, 0);
  await page.evaluate(() => {
    scrollTo(0, 1000);
  });
  await expect.poll(async () => (await pins(page)).length).toBe(0);
  await page.evaluate(() => {
    scrollTo(0, 80);
  });
  await expect.poll(async () => (await pins(page)).length).toBe(1);
  await page.locator('.hero').evaluate((hero) => {
    if (hero instanceof HTMLElement) hero.style.paddingTop = '160px';
  });
  await expect.poll(async () => (await pins(page))[0]?.y).toBeGreaterThan(original.y);
  await frame.getByRole('button', { name: 'Feedback', exact: false }).click();
  await frame.getByText('Heading feedback', { exact: true }).click();
  await page.setViewportSize({ width: 1024, height: 900 });
  await expect(frame.getByRole('button', { name: 'Back to feedback', exact: true })).toBeVisible();
  await expect
    .poll(async () => (await pins(page))[0]?.x)
    .toBeCloseTo(
      (await page.locator('[data-feedback-id="hero-heading"]').boundingBox())?.x ?? -1,
      0,
    );
  await page.locator('[data-feedback-id="hero-heading"]').evaluate((element) => {
    element.setAttribute('data-feedback-private', '');
  });
  await expect.poll(async () => (await pins(page)).length).toBe(0);
  await page.locator('[data-feedback-id="hero-heading"]').evaluate((element) => {
    element.removeAttribute('data-feedback-private');
    element.after(element.cloneNode(true));
  });
  await expect.poll(async () => (await pins(page)).length).toBe(0);
  await page
    .locator('[data-feedback-id="hero-heading"]')
    .last()
    .evaluate((element) => {
      element.remove();
    });
  await expect.poll(async () => (await pins(page)).length).toBe(1);
  await page.locator('[data-feedback-id="hero-heading"]').evaluate((element) => {
    element.setAttribute('hidden', '');
  });
  await expect.poll(async () => (await pins(page)).length).toBe(0);
  await page.locator('[data-feedback-id="hero-heading"]').evaluate((element) => {
    element.removeAttribute('hidden');
  });
  await expect.poll(async () => (await pins(page)).length).toBe(1);
  await page.evaluate(() => {
    history.pushState({}, '', '/other');
  });
  await expect.poll(async () => (await pins(page)).length).toBe(0);
  await expect(
    frame.getByRole('switch', { name: 'Show feedback pins', exact: true }),
  ).toBeVisible();
  await expect(frame.getByText('Different page feedback', { exact: true })).toBeVisible();
});

test('forged and oversized messages cannot render pins or open another thread; sign-out clears host metadata', async ({
  page,
}) => {
  await instrument(page);
  const project = await createProject(page);
  const thread = await createThread(
    page,
    project.id,
    '[data-feedback-id="hero-heading"]',
    'Authorized feedback body',
  );
  const frame = await openToolbar(page, project.id);
  const forged = {
    type: 'feedback:pins',
    url: `${website}/`,
    items: [{ threadId: thread.id, selector: '[data-feedback-id="hero-heading"]' }],
  };
  await page.evaluate((message) => {
    window.postMessage(message, location.origin);
  }, forged);
  expect(await pins(page)).toEqual([]);
  await page.route('http://localhost:44330/pin-spoof', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><title>Protocol source fixture</title>',
    }),
  );
  await page.evaluate(() => {
    const wrongSource = document.createElement('iframe');
    wrongSource.src = 'http://localhost:44330/pin-spoof';
    document.body.append(wrongSource);
  });
  await expect
    .poll(() => page.frames().some((frame) => frame.url().endsWith('/pin-spoof')))
    .toBe(true);
  const wrongSource = page.frames().find((frame) => frame.url().endsWith('/pin-spoof'));
  if (!wrongSource) throw new Error('Wrong-source fixture missing');
  await wrongSource.evaluate((message) => {
    parent.postMessage(message, 'http://localhost:44331');
  }, forged);
  // Wait for a round-trip through the authoritative frame before inspecting the result.
  await frame.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          resolve();
        });
      }),
  );
  expect(await pins(page)).toEqual([]);
  await page.locator('iframe[src$="/pin-spoof"]').evaluate((element) => {
    element.remove();
  });
  await frame.getByRole('switch', { name: 'Show feedback pins', exact: true }).click();
  await expect.poll(async () => (await pins(page)).length).toBe(1);
  await frame.evaluate((origin) => {
    parent.postMessage(
      {
        type: 'feedback:pins',
        url: `${origin}/`,
        items: Array.from({ length: 257 }, (_, index) => ({
          threadId: `forged_${index}`,
          selector: 'main',
        })),
      },
      origin,
    );
    parent.postMessage(
      {
        type: 'feedback:pins',
        url: `${origin}/`,
        items: [{ threadId: 'forged', selector: 'x'.repeat(701) }],
      },
      origin,
    );
    parent.postMessage(
      {
        type: 'feedback:pins',
        url: `${origin}/`,
        items: [
          { threadId: 'forged', selector: 'main' },
          { threadId: 'forged', selector: 'header' },
        ],
      },
      origin,
    );
    parent.postMessage({ type: 'feedback:pins', url: `${origin}/other`, items: [] }, origin);
  }, website);
  await expect.poll(async () => (await pins(page)).length).toBe(1);
  await page.evaluate(
    ({ id, url }) => {
      window.postMessage({ type: 'feedback:open-thread', threadId: id, url }, '*');
    },
    { id: thread.id, url: `${website}/` },
  );
  await frame.evaluate(
    ({ id, url }) => {
      // Same origin but wrong source must be rejected, too.
      window.postMessage({ type: 'feedback:open-thread', threadId: id, url }, location.origin);
    },
    { id: thread.id, url: `${website}/` },
  );
  await expect(frame.getByRole('button', { name: 'Back to feedback', exact: true })).toHaveCount(0);
  await frame.evaluate(
    ({ url, id }) => {
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: url.slice(0, -1),
          source: parent,
          data: { type: 'feedback:open-thread', threadId: id, url: `${url}other` },
        }),
      );
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: url.slice(0, -1),
          source: parent,
          data: { type: 'feedback:open-thread', threadId: 'not_loaded', url },
        }),
      );
    },
    { url: `${website}/`, id: thread.id },
  );
  await expect(frame.getByRole('button', { name: 'Back to feedback', exact: true })).toHaveCount(0);
  const messages = await pinMessages(page);
  expect(messages.flatMap((message) => message.items)).toContainEqual({
    threadId: thread.id,
    selector: thread.context.anchor.selector,
  });
  await clickPin(page, 1);
  await expect(frame.getByText('Authorized feedback body', { exact: true })).toBeVisible();
  await frame.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.locator('[data-feedback-host]')).toBeHidden();
  await expect.poll(async () => (await pins(page)).length).toBe(0);
  expect((await pinMessages(page)).at(-1)?.items).toEqual([]);
  await frame.evaluate((message) => {
    parent.postMessage(message, 'http://localhost:44331');
  }, forged);
  expect(await pins(page)).toEqual([]);
});

test('earlier loaded page pins survive refresh and resolving an older thread removes its pin', async ({
  page,
}) => {
  await instrument(page);
  const project = await createProject(page);
  const oldest = await createThread(
    page,
    project.id,
    '[data-feedback-id="hero-heading"]',
    'Oldest pinned feedback',
  );
  for (let index = 0; index < 50; index++)
    await createThread(page, project.id, `#missing-${index}`, `Newer feedback ${index}`);
  const frame = await openToolbar(page, project.id);
  await frame.getByRole('switch', { name: 'Show feedback pins', exact: true }).click();
  expect(await pins(page)).toEqual([]);
  await frame.getByRole('button', { name: 'Feedback', exact: false }).click();
  await frame.getByRole('button', { name: 'Load earlier feedback' }).click();
  await expect.poll(async () => (await pins(page)).length).toBe(1);
  expect((await pinMessages(page)).at(-1)?.items.some((item) => item.threadId === oldest.id)).toBe(
    true,
  );
  const refresh = page.waitForResponse(
    (response) => response.url().includes('/threads?') && response.url().includes('ids='),
  );
  await refresh;
  await expect.poll(async () => (await pins(page)).length).toBe(1);
  await clickPin(page, 51);
  await expect(frame.getByText('Oldest pinned feedback', { exact: true })).toBeVisible();
  expect(
    (
      await page.request.patch(`/api/threads/${oldest.id}`, { data: { status: 'resolved' } })
    ).status(),
  ).toBe(200);
  await expect.poll(async () => (await pins(page)).length, { timeout: 10_000 }).toBe(0);
});

test('system theme pins follow the applied default dark accent and OS theme changes without reload', async ({
  page,
}) => {
  await instrument(page);
  await page.emulateMedia({ colorScheme: 'dark' });
  const project = await createProject(page);
  expect(
    (
      await page.request.patch(`/api/projects/${project.id}`, {
        data: { theme: { mode: 'system', accent: '#0647ff', radius: 'square' } },
      })
    ).status(),
  ).toBe(200);
  await createThread(
    page,
    project.id,
    '[data-feedback-id="hero-heading"]',
    'System theme feedback',
  );
  const frame = await openToolbar(page, project.id);
  await frame.getByRole('switch', { name: 'Show feedback pins', exact: true }).click();
  await expect(frame.locator('html')).toHaveAttribute('data-mode', 'dark');
  await expect.poll(async () => (await pins(page))[0]?.color).toBe('rgb(40, 112, 255)');
  expect((await pins(page))[0]?.background).toBe('rgb(0, 0, 0)');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(frame.locator('html')).toHaveAttribute('data-mode', 'light');
  await expect.poll(async () => (await pins(page))[0]?.color).toBe('rgb(6, 71, 255)');
  expect((await pins(page))[0]?.background).toBe('rgb(255, 255, 255)');
});
