import type { Frame, Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { projectSchema, threadSchema } from '../src/shared/models.js';
import { test, expect } from './pins.fixtures.js';

const website = 'http://localhost:44331';
const service = new URL(website);
service.port = String(Number(service.port) - 1);

async function instrument(page: Page) {
  await page.addInitScript((serviceOrigin) => {
    let root: ShadowRoot | null = null;
    const messages: unknown[] = [];
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'attachShadow');
    if (!descriptor) throw new Error('Shadow root method missing');
    const prototype: unknown = Object.create(Element.prototype, { attachShadow: descriptor });
    if (!(prototype instanceof Element)) throw new Error('Element prototype missing');
    const originalAttach = (element: Element, options: ShadowRootInit) =>
      prototype.attachShadow.call(element, options);
    let selectorReads = 0;
    let geometryReads = 0;
    let animationReads = 0;
    const queryDescriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'querySelectorAll');
    const animationDescriptor = Object.getOwnPropertyDescriptor(
      Document.prototype,
      'getAnimations',
    );
    if (!queryDescriptor || !animationDescriptor)
      throw new Error('Document inspection methods missing');
    const documentPrototype: unknown = Object.create(Document.prototype, {
      querySelectorAll: queryDescriptor,
      getAnimations: animationDescriptor,
    });
    if (!(documentPrototype instanceof Document)) throw new Error('Document prototype missing');
    Object.defineProperty(document, 'querySelectorAll', {
      value(selector: string) {
        if (selector.startsWith('#motion') || selector.startsWith('#lifecycle')) selectorReads++;
        const query: unknown = Reflect.get(documentPrototype, 'querySelectorAll');
        if (typeof query !== 'function') throw new Error('Selector method missing');
        const result: unknown = Reflect.apply(query, document, [selector]);
        if (!(result instanceof NodeList)) throw new Error('Selector result missing');
        return result;
      },
    });
    Object.defineProperty(document, 'getAnimations', {
      configurable: true,
      value() {
        animationReads++;
        return documentPrototype.getAnimations.call(document);
      },
    });
    const rectDescriptor = Object.getOwnPropertyDescriptor(
      Element.prototype,
      'getBoundingClientRect',
    );
    if (!rectDescriptor) throw new Error('Geometry method missing');
    Object.defineProperty(prototype, 'getBoundingClientRect', rectDescriptor);
    Element.prototype.getBoundingClientRect = function () {
      if (this.id.startsWith('motion') || this.id.startsWith('lifecycle')) geometryReads++;
      return prototype.getBoundingClientRect.call(this);
    };
    Object.defineProperty(window, 'pinTestCounters', {
      get: () => ({ selectorReads, geometryReads, animationReads }),
    });
    Element.prototype.attachShadow = function (options) {
      const result = originalAttach(this, options);
      if (this.hasAttribute('data-feedback-host')) root = result;
      return result;
    };
    // Test-only access keeps the real root closed, including its event retargeting.
    Object.defineProperty(window, 'pinTestRoot', { get: () => root });
    Object.defineProperty(window, 'pinTestMessages', { get: () => messages });
    window.addEventListener('message', (event: MessageEvent<unknown>) => {
      const frame = root?.querySelector('iframe');
      if (event.origin !== serviceOrigin || event.source !== frame?.contentWindow) return;
      messages.push(event.data);
    });
  }, service.origin);
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
  // The last iframe control precedes the native pin controls in tab order.
  await frame.getByRole('button', { name: 'Sign out', exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect
    .poll(async () => (await pins(page)).find((pin) => pin.focused)?.outline)
    .toBe('solid');
  const focused = (await pins(page)).find((pin) => pin.focused);
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
  const spoofUrl = new URL('/pin-spoof', service).href;
  await page.route(spoofUrl, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><title>Protocol source fixture</title>',
    }),
  );
  await page.evaluate((url) => {
    const wrongSource = document.createElement('iframe');
    wrongSource.src = url;
    document.body.append(wrongSource);
  }, spoofUrl);
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

test('visibility regression hides content-visibility descendants and fully clipped anchors', async ({
  page,
}) => {
  await instrument(page);
  const project = await createProject(page);
  await createThread(page, project.id, '#visibility-anchor', 'Visibility regression');
  const frame = await openToolbar(page, project.id);
  await page.evaluate(() => {
    const container = document.createElement('section');
    container.id = 'visibility-container';
    container.style.cssText = 'position:fixed;left:100px;top:150px;width:120px;height:100px;';
    const anchor = document.createElement('button');
    anchor.id = 'visibility-anchor';
    anchor.textContent = 'Anchor';
    anchor.style.cssText = 'position:absolute;left:10px;top:10px;width:80px;height:50px;';
    container.append(anchor);
    document.body.append(container);
  });
  await frame.getByRole('switch', { name: 'Show feedback pins', exact: true }).click();
  await expect.poll(async () => (await pins(page)).length).toBe(1);
  await page.locator('#visibility-container').evaluate((container) => {
    if (container instanceof HTMLElement) container.style.contentVisibility = 'hidden';
  });
  const hiddenRect = await page.locator('#visibility-anchor').boundingBox();
  expect(hiddenRect?.width).toBeGreaterThan(0);
  await expect.poll(async () => (await pins(page)).length).toBe(0);
  await page.locator('#visibility-container').evaluate((container) => {
    if (container instanceof HTMLElement) {
      container.style.contentVisibility = 'visible';
      container.style.overflow = 'hidden';
    }
  });
  await expect.poll(async () => (await pins(page)).length).toBe(1);
  await page.locator('#visibility-anchor').evaluate((anchor) => {
    if (anchor instanceof HTMLElement) anchor.style.left = '150px';
  });
  const clippedRect = await page.locator('#visibility-anchor').boundingBox();
  expect(clippedRect?.x).toBeGreaterThan(0);
  expect(clippedRect?.x).toBeLessThan(1280);
  await expect.poll(async () => (await pins(page)).length).toBe(0);
});

test('motion regression keeps a pin attached at intermediate CSS transition positions', async ({
  page,
}) => {
  await instrument(page);
  const project = await createProject(page);
  await createThread(page, project.id, '#motion-anchor', 'Moving feedback');
  const frame = await openToolbar(page, project.id);
  await page.evaluate(() => {
    const anchor = document.createElement('button');
    anchor.id = 'motion-anchor';
    anchor.textContent = 'Moving anchor';
    anchor.style.cssText =
      'position:fixed;left:20px;top:160px;width:100px;height:50px;transition:left 3s linear;';
    document.body.append(anchor);
  });
  await frame.getByRole('switch', { name: 'Show feedback pins', exact: true }).click();
  await expect.poll(async () => (await pins(page))[0]?.x).toBe(20);
  await page.locator('#motion-anchor').evaluate((anchor) => {
    if (anchor instanceof HTMLElement) anchor.style.left = '320px';
  });
  await expect
    .poll(async () => (await page.locator('#motion-anchor').boundingBox())?.x)
    .toBeGreaterThan(100);
  const position = await page.evaluate(() => {
    const root: unknown = Reflect.get(window, 'pinTestRoot');
    if (!(root instanceof ShadowRoot)) throw new Error('Closed test root missing');
    const pin = root.querySelector('button');
    const anchor = document.getElementById('motion-anchor');
    if (!pin || !anchor) throw new Error('Moving anchor or pin missing');
    return { pin: pin.getBoundingClientRect().x, anchor: anchor.getBoundingClientRect().x };
  });
  expect(position.anchor).toBeLessThan(320);
  expect(Math.abs(position.pin - position.anchor)).toBeLessThan(8);
});

test('visibility regression hides an in-viewport anchor wholly outside an overflow clip', async ({
  page,
}) => {
  await instrument(page);
  const project = await createProject(page);
  await createThread(page, project.id, '#clipped-anchor', 'Clipped feedback');
  const frame = await openToolbar(page, project.id);
  await page.evaluate(() => {
    const container = document.createElement('section');
    container.style.cssText =
      'position:fixed;left:100px;top:150px;width:120px;height:100px;overflow:hidden';
    const anchor = document.createElement('button');
    anchor.id = 'clipped-anchor';
    anchor.textContent = 'Clipped anchor';
    anchor.style.cssText = 'position:absolute;left:150px;top:10px;width:80px;height:50px;';
    container.append(anchor);
    document.body.append(container);
  });
  await frame.getByRole('switch', { name: 'Show feedback pins', exact: true }).click();
  const rect = await page.locator('#clipped-anchor').boundingBox();
  expect(rect?.width).toBeGreaterThan(0);
  expect(rect?.x).toBeGreaterThan(0);
  expect(rect?.x).toBeLessThan(1280);
  await expect.poll(async () => (await pins(page)).length).toBe(0);
});

test('partial overflow clips place pins inside scaled padding edges and honor each overflow axis', async ({
  page,
}) => {
  await instrument(page);
  const project = await createProject(page);
  await createThread(page, project.id, '#axis-anchor', 'Partially clipped feedback');
  const frame = await openToolbar(page, project.id);
  await page.evaluate(() => {
    const container = document.createElement('section');
    container.id = 'axis-container';
    container.style.cssText =
      'position:fixed;left:100px;top:150px;width:160px;height:120px;border:10px solid black;padding:10px;transform:scale(1.5);transform-origin:top left;overflow-x:clip;overflow-y:visible';
    const anchor = document.createElement('button');
    anchor.id = 'axis-anchor';
    anchor.textContent = 'Partially clipped';
    anchor.style.cssText = 'position:absolute;left:-30px;top:130px;width:100px;height:50px';
    container.append(anchor);
    document.body.append(container);
  });
  await frame.getByRole('switch', { name: 'Show feedback pins', exact: true }).click();
  await expect.poll(async () => (await pins(page)).length).toBe(1);
  await expect.poll(async () => (await pins(page))[0]?.x).toBe(115);
  const anchor = await page.locator('#axis-anchor').boundingBox();
  expect(anchor?.x).toBe(70);
  expect((await pins(page))[0]?.y).toBe(anchor?.y);
  await clickPin(page, 1);
  await expect(frame.getByText('Partially clipped feedback', { exact: true })).toBeVisible();
  await page.locator('#axis-anchor').evaluate((element) => {
    if (element instanceof HTMLElement) element.style.left = '-95px';
  });
  // Only 7.5px remains visible; there is no safe space for a 32px control.
  await expect.poll(async () => (await pins(page)).length).toBe(0);
  await page.locator('#axis-anchor').evaluate((element) => {
    if (element instanceof HTMLElement) element.style.left = '-30px';
  });
  await expect.poll(async () => (await pins(page)).length).toBe(1);
  await page.locator('#axis-container').evaluate((container) => {
    if (container instanceof HTMLElement) {
      container.style.overflowX = 'visible';
      container.style.overflowY = 'clip';
    }
  });
  await expect.poll(async () => (await pins(page)).length).toBe(0);
  await page.locator('#axis-anchor').evaluate((element) => {
    if (element instanceof HTMLElement) element.style.top = '20px';
  });
  await expect.poll(async () => (await pins(page)).length).toBe(1);
  expect((await pins(page))[0]?.x).toBe(70);
});

async function counters(page: Page) {
  const value: unknown = await page.evaluate(() => {
    const result: unknown = Reflect.get(window, 'pinTestCounters');
    return result;
  });
  return z
    .object({ selectorReads: z.number(), geometryReads: z.number(), animationReads: z.number() })
    .parse(value);
}

async function intermediatePosition(page: Page, id: string) {
  return page.evaluate((id) => {
    const root: unknown = Reflect.get(window, 'pinTestRoot');
    if (!(root instanceof ShadowRoot)) throw new Error('Closed test root missing');
    const pin = root.querySelector('button');
    const anchor = document.getElementById(id);
    if (!pin || !anchor) throw new Error('Moving pin or anchor missing');
    return { pin: pin.getBoundingClientRect().x, anchor: anchor.getBoundingClientRect().x };
  }, id);
}

async function waitForFrames(page: Page, duration: number) {
  await page.evaluate(
    (duration) =>
      new Promise<void>((resolve) => {
        const start = performance.now();
        const next = () => {
          if (performance.now() - start >= duration) resolve();
          else requestAnimationFrame(next);
        };
        requestAnimationFrame(next);
      }),
    duration,
  );
}

test('ancestor Web Animations track intermediate positions, pause and cancel without idle selector or frame work', async ({
  page,
}) => {
  await instrument(page);
  const project = await createProject(page);
  await createThread(page, project.id, '#motion-child', 'Ancestor motion feedback');
  const frame = await openToolbar(page, project.id);
  await page.evaluate(() => {
    const parent = document.createElement('section');
    parent.id = 'motion-parent';
    parent.style.cssText = 'position:fixed;left:20px;top:160px;width:100px;height:50px';
    const anchor = document.createElement('button');
    anchor.id = 'motion-child';
    anchor.textContent = 'Moving child';
    anchor.style.cssText = 'width:100px;height:50px';
    parent.append(anchor);
    document.body.append(parent);
  });
  await frame.getByRole('switch', { name: 'Show feedback pins', exact: true }).click();
  await expect.poll(async () => (await pins(page))[0]?.x).toBe(20);
  await waitForFrames(page, 200);
  const idle = await counters(page);
  await waitForFrames(page, 400);
  const quiet = await counters(page);
  expect(quiet.selectorReads - idle.selectorReads).toBe(0);
  expect(quiet.geometryReads - idle.geometryReads).toBe(0);
  expect(quiet.animationReads - idle.animationReads).toBeLessThanOrEqual(3);
  await page.evaluate(() => {
    const parent = document.getElementById('motion-parent');
    if (!parent) throw new Error('Moving ancestor missing');
    const animation = parent.animate(
      [{ transform: 'translateX(0)' }, { transform: 'translateX(300px)' }],
      { duration: 3000, iterations: Infinity },
    );
    Object.defineProperty(window, 'pinTestAnimation', { value: animation, configurable: true });
  });
  await expect
    .poll(async () => (await intermediatePosition(page, 'motion-child')).anchor)
    .toBeGreaterThan(100);
  const before = await counters(page);
  for (let sample = 0; sample < 4; sample++) {
    const position = await intermediatePosition(page, 'motion-child');
    expect(position.anchor).toBeLessThan(320);
    expect(Math.abs(position.pin - position.anchor)).toBeLessThan(8);
    await waitForFrames(page, 100);
  }
  expect((await counters(page)).selectorReads - before.selectorReads).toBe(0);
  await page.evaluate(() => {
    const animation: unknown = Reflect.get(window, 'pinTestAnimation');
    if (!(animation instanceof Animation)) throw new Error('Web Animation missing');
    animation.pause();
  });
  await waitForFrames(page, 200);
  const paused = await counters(page);
  await waitForFrames(page, 300);
  expect((await counters(page)).geometryReads - paused.geometryReads).toBe(0);
  await page.evaluate(() => {
    const animation: unknown = Reflect.get(window, 'pinTestAnimation');
    if (!(animation instanceof Animation)) throw new Error('Web Animation missing');
    animation.play();
  });
  await expect
    .poll(async () => (await counters(page)).geometryReads)
    .toBeGreaterThan(paused.geometryReads);
  await page.evaluate(() => {
    const animation: unknown = Reflect.get(window, 'pinTestAnimation');
    if (!(animation instanceof Animation)) throw new Error('Web Animation missing');
    animation.cancel();
  });
  await expect.poll(async () => (await pins(page))[0]?.x).toBe(20);
  await waitForFrames(page, 200);
  const cancelled = await counters(page);
  await waitForFrames(page, 300);
  expect((await counters(page)).geometryReads - cancelled.geometryReads).toBe(0);
  await frame.getByRole('switch', { name: 'Hide feedback pins', exact: true }).click();
  await expect.poll(async () => (await pins(page)).length).toBe(0);
  const empty = await counters(page);
  await waitForFrames(page, 400);
  expect(await counters(page)).toEqual(empty);
});

test('infinite ancestor CSS animation follows motion and stops frame sampling for reduced motion and cancellation', async ({
  page,
}) => {
  await instrument(page);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const project = await createProject(page);
  await createThread(page, project.id, '#motion-child', 'CSS ancestor feedback');
  const frame = await openToolbar(page, project.id);
  await page.addStyleTag({
    content:
      '@keyframes pin-test-move { from { transform:translateX(0) } to { transform:translateX(300px) } } @media (prefers-reduced-motion:reduce) { #motion-parent { animation:none!important } }',
  });
  await page.evaluate(() => {
    const parent = document.createElement('section');
    parent.id = 'motion-parent';
    parent.style.cssText = 'position:fixed;left:20px;top:160px;width:100px;height:50px';
    const anchor = document.createElement('button');
    anchor.id = 'motion-child';
    anchor.textContent = 'CSS child';
    anchor.style.cssText = 'width:100px;height:50px';
    parent.append(anchor);
    document.body.append(parent);
  });
  await frame.getByRole('switch', { name: 'Show feedback pins', exact: true }).click();
  await expect.poll(async () => (await pins(page))[0]?.x).toBe(20);
  await page.locator('#motion-parent').evaluate((parent) => {
    if (parent instanceof HTMLElement) parent.style.animation = 'pin-test-move 3s linear infinite';
  });
  await expect
    .poll(async () => (await intermediatePosition(page, 'motion-child')).anchor)
    .toBeGreaterThan(100);
  const position = await intermediatePosition(page, 'motion-child');
  expect(position.anchor).toBeLessThan(320);
  expect(Math.abs(position.pin - position.anchor)).toBeLessThan(8);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect.poll(async () => (await pins(page))[0]?.x).toBe(20);
  await waitForFrames(page, 200);
  const reduced = await counters(page);
  await waitForFrames(page, 300);
  expect((await counters(page)).geometryReads - reduced.geometryReads).toBe(0);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect
    .poll(async () => (await intermediatePosition(page, 'motion-child')).anchor)
    .toBeGreaterThan(100);
  await page.locator('#motion-parent').evaluate((parent) => {
    if (parent instanceof HTMLElement) parent.style.animation = 'none';
  });
  await expect.poll(async () => (await pins(page))[0]?.x).toBe(20);
  await waitForFrames(page, 200);
  const cancelled = await counters(page);
  await waitForFrames(page, 300);
  expect((await counters(page)).geometryReads - cancelled.geometryReads).toBe(0);
});

test('destroy removes moving pins and stops geometry reads and animation registry polling', async ({
  page,
}) => {
  await instrument(page);
  const project = await createProject(page);
  await createThread(page, project.id, '#lifecycle-anchor', 'Lifecycle feedback');
  await page.route('http://localhost:44330/embed-module.js', async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      headers: { ...response.headers(), 'access-control-allow-origin': website },
    });
  });
  await page.goto(`${website}/`);
  await page.evaluate(async (projectId) => {
    const anchor = document.createElement('button');
    anchor.id = 'lifecycle-anchor';
    anchor.textContent = 'Lifecycle anchor';
    anchor.style.cssText = 'position:fixed;left:20px;top:160px;width:100px;height:50px';
    document.body.append(anchor);
    const address = 'http://localhost:44330/embed-module.js';
    const library: unknown = await import(address);
    if (typeof library !== 'object' || library === null) throw new Error('Embed module missing');
    const mount: unknown = Reflect.get(library, 'mountFeedback');
    if (typeof mount !== 'function') throw new Error('Embed mount function missing');
    const controller: unknown = Reflect.apply(mount, null, [
      { server: 'http://localhost:44330', projectId },
    ]);
    if (typeof controller !== 'object' || controller === null)
      throw new Error('Embed controller missing');
    const destroy: unknown = Reflect.get(controller, 'destroy');
    if (typeof destroy !== 'function') throw new Error('Embed destroy function missing');
    Object.defineProperty(window, 'pinTestDestroy', {
      value() {
        Reflect.apply(destroy, controller, []);
      },
    });
  }, project.id);
  await expect(page.locator('[data-feedback-host]')).toBeVisible({ timeout: 15_000 });
  const frame = page.frames().find((frame) => frame.url().includes('/toolbar?'));
  if (!frame) throw new Error('Toolbar frame missing');
  await expect(
    frame.getByRole('switch', { name: 'Show feedback pins', exact: true }),
  ).toBeEnabled();
  await frame.getByRole('switch', { name: 'Show feedback pins', exact: true }).click();
  await expect.poll(async () => (await pins(page))[0]?.x).toBe(20);
  await page.locator('#lifecycle-anchor').evaluate((anchor) => {
    anchor.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(300px)' }], {
      duration: 3000,
      iterations: Infinity,
    });
  });
  await expect
    .poll(async () => (await intermediatePosition(page, 'lifecycle-anchor')).anchor)
    .toBeGreaterThan(100);
  const position = await intermediatePosition(page, 'lifecycle-anchor');
  expect(Math.abs(position.pin - position.anchor)).toBeLessThan(8);
  await page.evaluate(() => {
    const destroy: unknown = Reflect.get(window, 'pinTestDestroy');
    if (typeof destroy !== 'function') throw new Error('Test destroy function missing');
    Reflect.apply(destroy, null, []);
  });
  await expect(page.locator('[data-feedback-host]')).toHaveCount(0);
  expect(await pins(page)).toEqual([]);
  const stopped = await counters(page);
  await waitForFrames(page, 400);
  expect(await counters(page)).toEqual(stopped);
});

test('viewport-fixed descendants escape ordinary ancestor overflow, while transformed containing blocks clip them', async ({
  page,
}) => {
  await instrument(page);
  const project = await createProject(page);
  await createThread(page, project.id, '#fixed-anchor', 'Fixed feedback');
  const frame = await openToolbar(page, project.id);
  await page.evaluate(() => {
    const container = document.createElement('section');
    container.id = 'fixed-container';
    container.style.cssText =
      'position:fixed;left:100px;top:150px;width:120px;height:100px;overflow:hidden';
    const anchor = document.createElement('button');
    anchor.id = 'fixed-anchor';
    anchor.textContent = 'Fixed anchor';
    anchor.style.cssText = 'position:fixed;left:300px;top:160px;width:80px;height:50px';
    container.append(anchor);
    document.body.append(container);
  });
  await frame.getByRole('switch', { name: 'Show feedback pins', exact: true }).click();
  await expect.poll(async () => (await pins(page)).length).toBe(1);
  expect((await pins(page))[0]?.x).toBe(300);
  await page.locator('#fixed-container').evaluate((container) => {
    if (container instanceof HTMLElement) container.style.transform = 'translateX(0)';
  });
  await expect.poll(async () => (await pins(page)).length).toBe(0);
});

test('Show element can still scroll to an off-screen public anchor while pins remain viewport scoped', async ({
  page,
}) => {
  await instrument(page);
  const project = await createProject(page);
  await createThread(
    page,
    project.id,
    '[data-feedback-id="hero-heading"]',
    'Off-screen heading feedback',
  );
  const frame = await openToolbar(page, project.id);
  await frame.getByRole('switch', { name: 'Show feedback pins', exact: true }).click();
  await expect.poll(async () => (await pins(page)).length).toBe(1);
  await clickPin(page, 1);
  await expect(frame.getByText('Off-screen heading feedback', { exact: true })).toBeVisible();
  await page.evaluate(() => {
    scrollTo(0, 1000);
  });
  await expect.poll(async () => (await pins(page)).length).toBe(0);
  await frame.getByRole('button', { name: 'Show element', exact: true }).click();
  await expect.poll(() => page.evaluate(() => scrollY)).toBeLessThan(200);
  await expect.poll(async () => (await pins(page)).length).toBe(1);
  await expect(frame.getByRole('alert')).toHaveCount(0);
});

test('CSS transition events keep pins attached and stop after cancellation when animation registry is unavailable', async ({
  page,
}) => {
  await instrument(page);
  const project = await createProject(page);
  await createThread(page, project.id, '#motion-anchor', 'Transition fallback feedback');
  const frame = await openToolbar(page, project.id);
  await page.evaluate(() => {
    Object.defineProperty(document, 'getAnimations', { value: undefined, configurable: true });
    const anchor = document.createElement('button');
    anchor.id = 'motion-anchor';
    anchor.textContent = 'Transition anchor';
    anchor.style.cssText =
      'position:fixed;left:20px;top:160px;width:100px;height:50px;transition:left 3s linear';
    document.body.append(anchor);
  });
  await frame.getByRole('switch', { name: 'Show feedback pins', exact: true }).click();
  await expect.poll(async () => (await pins(page))[0]?.x).toBe(20);
  await page.locator('#motion-anchor').evaluate((anchor) => {
    if (anchor instanceof HTMLElement) anchor.style.left = '320px';
  });
  await expect
    .poll(async () => (await intermediatePosition(page, 'motion-anchor')).anchor)
    .toBeGreaterThan(100);
  const position = await intermediatePosition(page, 'motion-anchor');
  expect(Math.abs(position.pin - position.anchor)).toBeLessThan(8);
  await page.locator('#motion-anchor').evaluate((anchor) => {
    if (anchor instanceof HTMLElement) {
      anchor.style.transition = 'none';
      anchor.style.left = '120px';
    }
  });
  await expect.poll(async () => (await pins(page))[0]?.x).toBe(120);
  await waitForFrames(page, 200);
  const stopped = await counters(page);
  await waitForFrames(page, 300);
  expect((await counters(page)).geometryReads - stopped.geometryReads).toBe(0);
});
