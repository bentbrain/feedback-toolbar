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

test('shared element feedback follows its anchor onto a nested route', async ({ page }) => {
  await instrument(page);
  const project = await createProject(page);
  await createThread(
    page,
    project.id,
    '[data-feedback-id="hero-heading"]',
    'Shared heading feedback',
  );
  await createThread(page, project.id, '#root-only', 'Root-only feedback');
  const frame = await openToolbar(page, project.id);
  await page.evaluate(() => {
    history.pushState({}, '', '/owner');
  });
  await expect.poll(async () => (await pinMessages(page)).at(-1)?.url).toBe(`${website}/owner`);
  await expect(
    frame.getByRole('switch', { name: 'Show feedback pins', exact: true }),
  ).toBeEnabled();
  await frame.getByRole('button', { name: 'Feedback', exact: false }).click();
  await expect(frame.getByText('Shared heading feedback', { exact: true })).toBeVisible();
  await expect(frame.getByText('Root-only feedback', { exact: true })).toBeHidden();
  await frame.getByRole('switch', { name: 'Show feedback pins', exact: true }).click();
  await expect.poll(async () => (await pins(page)).length).toBe(1);
  await page.screenshot({ path: '.data/review/shared-feedback-after.png' });
  await clickPin(page, 1);
  await expect(frame.getByText('Shared heading feedback', { exact: true })).toBeVisible();
  await expect(frame.getByRole('button', { name: 'Back to feedback', exact: true })).toBeVisible();
  await frame.getByRole('button', { name: 'Back to feedback', exact: true }).click();
  await page.locator('[data-feedback-id="hero-heading"]').evaluate((element) => {
    element.setAttribute('hidden', '');
  });
  await expect(frame.getByText('Shared heading feedback', { exact: true })).toBeHidden();
  await expect.poll(async () => (await pins(page)).length).toBe(0);
  await page.locator('[data-feedback-id="hero-heading"]').evaluate((element) => {
    element.removeAttribute('hidden');
    element.setAttribute('data-feedback-private', '');
  });
  await expect(frame.getByText('Shared heading feedback', { exact: true })).toBeHidden();
  await page.locator('[data-feedback-id="hero-heading"]').evaluate((element) => {
    element.removeAttribute('data-feedback-private');
  });
  await expect(frame.getByText('Shared heading feedback', { exact: true })).toBeVisible();
  await expect.poll(async () => (await pins(page)).length).toBe(1);
});

test('shared header SVG feedback loads directly on nested routes without including another origin', async ({
  page,
}) => {
  await instrument(page);
  const project = await createProject(page);
  const otherOrigin = 'https://other.example';
  expect(
    (
      await page.request.patch(`/api/projects/${project.id}`, {
        data: { origins: [website, otherOrigin] },
      })
    ).status(),
  ).toBe(200);
  await createThread(page, project.id, 'body > header > svg', 'Shared header icon feedback');
  await createThread(
    page,
    project.id,
    'body > header > svg',
    'Other website feedback',
    `${otherOrigin}/`,
  );
  await page.addInitScript((origin) => {
    // The demo server serves only /. Start the embed on a nested pathname
    // before any page scripts run, using the real loopback document response.
    if (location.origin !== origin) return;
    history.replaceState({}, '', `/owner${location.search}`);
    document.addEventListener('DOMContentLoaded', () => {
      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      icon.setAttribute('viewBox', '0 0 16 16');
      icon.style.cssText = 'width:22px;height:22px';
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', 'M2 2h12v12H2z');
      icon.append(path);
      document.querySelector('body > header')?.append(icon);
    });
  }, website);
  const frame = await openToolbar(page, project.id);
  await expect(page).toHaveURL(`${website}/owner?project=${project.id}`);
  await frame.getByRole('button', { name: 'Feedback', exact: false }).click();
  await expect(frame.getByText('Shared header icon feedback', { exact: true })).toBeVisible();
  await expect(frame.getByText('Other website feedback', { exact: true })).toBeHidden();
  await frame.getByRole('switch', { name: 'Show feedback pins', exact: true }).click();
  await expect.poll(async () => (await pins(page)).length).toBe(1);
  await frame.getByRole('button', { name: 'Minimize toolbar', exact: true }).click();
  await expect(page.locator('[data-feedback-host]')).toHaveCSS('height', '56px');
  await clickPin(page, 1);
  await expect(frame.getByText('Shared header icon feedback', { exact: true })).toBeVisible();
  await expect(frame.getByRole('button', { name: 'Back to feedback', exact: true })).toBeVisible();
});

test('selection keeps an Astro table header cell granular through hover and compose', async ({
  page,
}) => {
  await instrument(page);
  const project = await createProject(page);
  const frame = await openToolbar(page, project.id);
  await page.evaluate(() => {
    const main = document.querySelector('main');
    if (!main) throw new Error('Main missing');
    main.innerHTML =
      '<astro-island style="display:contents"><div><table style="border-collapse:collapse;width:100%;table-layout:fixed"><thead><tr><th>Title</th><th>Published</th><th>Status</th></tr></thead></table></div></astro-island>';
    main.setAttribute('style', 'padding:24px;padding-top:0;margin-top:0');
    main.setAttribute('data-feedback-redact', '');
    main.setAttribute('data-feedback-private', '');
    for (const cell of main.querySelectorAll('th'))
      cell.setAttribute('style', 'height:40px;padding:0;text-align:left');
  });
  const cell = page.locator('th').nth(1);
  await frame.getByRole('button', { name: 'Select an element', exact: true }).click();
  await cell.hover();
  const highlightBounds = () =>
    page.evaluate(() => {
      const root: unknown = Reflect.get(window, 'pinTestRoot');
      if (!(root instanceof ShadowRoot)) throw new Error('Closed test root missing');
      const highlight = Array.from(root.children).find(
        (element) => element instanceof HTMLElement && element.style.pointerEvents === 'none',
      );
      const rect = highlight?.getBoundingClientRect();
      return rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null;
    });
  const bounds = await cell.boundingBox();
  if (!bounds) throw new Error('Table header cell missing');
  await expect.poll(highlightBounds).toMatchObject(bounds);
  await page.screenshot({ path: '.data/review/table-selection.png' });
  await cell.evaluate((element) => {
    element.setAttribute('aria-label', 'Unpublished itinerary metadata');
  });
  await cell.click();
  await expect(
    frame.getByText('astro-island > div > table > thead > tr > th:nth-of-type(2)', { exact: true }),
  ).toBeVisible();
  await expect(frame.getByText('[Private element]', { exact: true })).toBeVisible();
  await expect(frame.getByText('Published', { exact: true })).toBeHidden();
  await expect.poll(highlightBounds).toMatchObject(bounds);
  await frame.getByLabel('What would you like to change?').fill('Adjust this column spacing');
  const posted = page.waitForResponse(
    (response) => response.url().endsWith('/threads') && response.request().method() === 'POST',
  );
  await frame.getByRole('button', { name: 'Post feedback', exact: true }).click();
  const result = z.object({ thread: threadSchema }).parse(await (await posted).json());
  expect(result.thread.context.anchor).toMatchObject({
    tag: 'th',
    text: '[Private element]',
    label: '',
  });
  await frame.getByRole('switch', { name: 'Show feedback pins', exact: true }).click();
  await expect.poll(async () => (await pins(page)).length).toBe(1);
  await frame.getByRole('button', { name: 'Back to feedback', exact: true }).click();
  await frame.getByRole('button', { name: 'New feedback', exact: true }).click();
  await page.locator('body > header').hover();
  expect(await highlightBounds()).not.toEqual(bounds);
  await cell.evaluate((element) => {
    element.setAttribute('data-feedback-private', '');
  });
  await cell.hover();
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const root: unknown = Reflect.get(window, 'pinTestRoot');
        if (!(root instanceof ShadowRoot)) throw new Error('Closed test root missing');
        const highlight = Array.from(root.children).find(
          (element) => element instanceof HTMLElement && element.style.pointerEvents === 'none',
        );
        return highlight ? getComputedStyle(highlight).display : null;
      }),
    )
    .toBe('none');
});

for (const marker of ['distinct', 'duplicate', 'oversized']) {
  test(`deep child selection saves a unique selector with ${marker} ancestor markers`, async ({
    page,
  }) => {
    await instrument(page);
    const project = await createProject(page);
    const frame = await openToolbar(page, project.id);
    await page.evaluate((markerKind) => {
      const main = document.querySelector('main');
      if (!main) throw new Error('Main missing');
      const child =
        '<div><div><div><div><div><div><button type="button"><span><svg width="24" height="24" viewBox="0 0 24 24"><path d="M2 2h20v20H2z" /></svg></span></button></div></div></div></div></div></div>';
      main.innerHTML = ['primary', 'secondary']
        .map((name) => {
          const markerValue =
            markerKind === 'distinct'
              ? name
              : markerKind === 'duplicate'
                ? 'shared'
                : 'x'.repeat(710);
          return `<section id="repeated-editor" data-feedback-id="editor-${markerValue}">${child}</section>`;
        })
        .join('');
    }, marker);
    await frame.getByRole('button', { name: 'Select an element', exact: true }).click();
    await page.locator('main section:first-of-type path').click();
    await frame.getByLabel('What would you like to change?').fill('Adjust this nested icon');
    const posted = page.waitForResponse(
      (response) => response.url().endsWith('/threads') && response.request().method() === 'POST',
    );
    await frame.getByRole('button', { name: 'Post feedback', exact: true }).click();
    const result = z.object({ thread: threadSchema }).parse(await (await posted).json());
    expect(result.thread.context.anchor.tag).toBe('path');
    expect(
      await page.evaluate((selector) => {
        const matches = document.querySelectorAll(selector);
        return (
          matches.length === 1 &&
          matches[0] === document.querySelector('main section:first-of-type path')
        );
      }, result.thread.context.anchor.selector),
    ).toBe(true);
    await frame.getByRole('switch', { name: 'Show feedback pins', exact: true }).click();
    await expect.poll(async () => (await pins(page)).length).toBe(1);
  });
}

test('an unresolvable selection stays in selection mode and can recover on a containing element', async ({
  page,
}) => {
  await instrument(page);
  const project = await createProject(page);
  const frame = await openToolbar(page, project.id);
  await page.evaluate(() => {
    const main = document.querySelector('main');
    if (!main) throw new Error('Main missing');
    const child =
      '<div>'.repeat(150) + '<button type="button">Nested control</button>' + '</div>'.repeat(150);
    main.innerHTML = `<section>${child}</section><section>${child}</section>`;
    main.style.padding = '24px';
  });
  await frame.getByRole('button', { name: 'Select an element', exact: true }).click();
  await page.locator('main section:first-of-type button').click();
  await expect(frame.getByRole('alert')).toHaveText(
    'This element cannot be identified reliably. Select a containing element.',
  );
  await expect(frame.getByRole('button', { name: 'Cancel selection', exact: true })).toBeVisible();
  await page.locator('main').click({ position: { x: 2, y: 2 } });
  await expect(frame.getByLabel('What would you like to change?')).toBeVisible();
  await expect(frame.getByRole('alert')).toBeHidden();
});

for (const target of ['#editor-title', '#editor-paragraph']) {
  test(`redacted editor target ${target} remains granular and resolves its feedback pin`, async ({
    page,
  }) => {
    await instrument(page);
    const project = await createProject(page);
    const frame = await openToolbar(page, project.id);
    await page.evaluate(() => {
      const main = document.querySelector('main');
      if (!main) throw new Error('Main missing');
      main.setAttribute('data-feedback-private', '');
      main.setAttribute('data-feedback-redact', '');
      main.innerHTML =
        '<label for="editor-title">Title</label><input id="editor-title" value="Unpublished title" aria-label="Unpublished title metadata"><div contenteditable="true"><p id="editor-paragraph" aria-label="Unpublished paragraph metadata">Unpublished paragraph</p></div>';
    });
    const element = page.locator(target);
    await frame.getByRole('button', { name: 'Select an element', exact: true }).click();
    await element.click();
    await expect(frame.getByText(target, { exact: true })).toBeVisible();
    await expect(frame.getByText('[Private element]', { exact: true })).toBeVisible();
    await frame.getByLabel('What would you like to change?').fill('Adjust this editor element');
    const posted = page.waitForResponse(
      (response) => response.url().endsWith('/threads') && response.request().method() === 'POST',
    );
    await frame.getByRole('button', { name: 'Post feedback', exact: true }).click();
    const result = z.object({ thread: threadSchema }).parse(await (await posted).json());
    expect(result.thread.context.anchor).toMatchObject({
      selector: target,
      text: '[Private element]',
      label: '',
    });
    await frame.getByRole('switch', { name: 'Show feedback pins', exact: true }).click();
    await expect.poll(async () => (await pins(page)).length).toBe(1);
    if (target === '#editor-paragraph')
      await page.screenshot({ path: '.data/review/editor-anchor-after.png' });
    await frame.getByRole('button', { name: 'Back to feedback', exact: true }).click();
    await clickPin(page, 1);
    await expect(frame.getByText('Adjust this editor element', { exact: true })).toBeVisible();
    await page.locator('main').evaluate((node) => {
      node.removeAttribute('data-feedback-redact');
    });
    await expect.poll(async () => (await pins(page)).length).toBe(0);
    await page.locator('main').evaluate((node) => {
      node.setAttribute('data-feedback-redact', '');
    });
    await expect.poll(async () => (await pins(page)).length).toBe(1);
    await element.evaluate((node) => {
      node.setAttribute('data-feedback-private', '');
    });
    await expect.poll(async () => (await pins(page)).length).toBe(0);
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

test('Japan header and decorative beer SVG pins use their own viewport anchors', async ({
  page,
}) => {
  await instrument(page);
  await page.setViewportSize({ width: 1778, height: 1024 });
  const project = await createProject(page);
  for (const anchor of [
    {
      selector: 'body > header',
      tag: 'header',
      rect: { x: 0, y: 0, width: 1778, height: 55 },
    },
    {
      selector: 'body > header > div > svg',
      tag: 'svg',
      rect: { x: 1670.3046875, y: 15.953125, width: 22.09375, height: 22.09375 },
    },
  ]) {
    const response = await page.request.post(`/api/projects/${project.id}/threads`, {
      data: {
        body: `${anchor.tag} feedback`,
        context: {
          url: `${website}/`,
          viewport: { width: 1778, height: 1024 },
          deployment: null,
          anchor: { ...anchor, feedbackId: null, text: '', label: '' },
        },
      },
    });
    expect(response.status()).toBe(201);
  }
  const frame = await openToolbar(page, project.id);
  await page.evaluate(() => {
    document.querySelector('.demo-notice')?.remove();
    const header = document.querySelector('body > header');
    if (!(header instanceof HTMLElement)) throw new Error('Header missing');
    header.style.cssText =
      'height:55px;padding:0;border:0;border-bottom:1px solid;display:flex;align-items:center;justify-content:space-between';
    const brand = document.createElement('a');
    brand.textContent = 'jp.bent.build';
    const nav = document.createElement('nav');
    nav.textContent = 'journal gallery';
    const beer = document.createElement('div');
    beer.dataset.feedbackId = 'beer-counter';
    beer.style.cssText = 'display:flex;align-items:center;gap:7px;margin-right:24px';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.style.cssText = 'width:22.09375px;height:22.09375px';
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M2 2h10v12H2z');
    svg.append(path);
    const label = document.createElement('span');
    label.textContent = '0 beers';
    label.style.cssText = 'width:54.609375px;flex-shrink:0';
    beer.append(svg, label);
    header.replaceChildren(brand, nav, beer);
  });
  expect(await page.locator('body > header').boundingBox()).toEqual({
    x: 0,
    y: 0,
    width: 1778,
    height: 55,
  });
  expect(await page.locator('body > header > div > svg').boundingBox()).toEqual({
    x: expect.closeTo(1670.3046875, 1),
    y: 15.953125,
    width: 22.09375,
    height: 22.09375,
  });
  await frame.getByRole('switch', { name: 'Show feedback pins', exact: true }).click();
  await expect.poll(async () => (await pins(page)).length).toBe(2);
  const visible = await pins(page);
  expect(visible.find((pin) => pin.text === '1')?.x).toBeCloseTo(1670.3046875, 1);
  expect(visible.find((pin) => pin.text === '1')?.y).toBeCloseTo(15.953125, 1);
  expect(visible.find((pin) => pin.text === '2')).toMatchObject({ x: 8, y: 8 });
  await clickPin(page, 1);
  await expect(frame.getByText('svg feedback', { exact: true })).toBeVisible();
  expect((await pins(page)).find((pin) => pin.text === '1')?.x).toBeCloseTo(1670.3046875, 1);
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect
    .poll(async () => (await pins(page)).find((pin) => pin.text === '1')?.x)
    .toBeCloseTo(1172.3046875, 1);
  await frame.getByRole('switch', { name: 'Hide feedback pins', exact: true }).click();
  await frame.getByRole('button', { name: 'Back to feedback', exact: true }).click();
  await frame.getByRole('button', { name: 'New feedback', exact: true }).click();
  await page.locator('body > header > div > svg').click({ position: { x: 20, y: 20 } });
  await expect(
    frame.getByText('[data-feedback-id="beer-counter"] > svg', { exact: true }),
  ).toBeVisible();
});

test('pins on distinct adjacent anchors stay separate and keyboard accessible after reflow', async ({
  page,
}) => {
  await instrument(page);
  const project = await createProject(page);
  await createThread(page, project.id, '#adjacent-first', 'First adjacent feedback');
  await createThread(page, project.id, '#adjacent-second', 'Second adjacent feedback');
  const frame = await openToolbar(page, project.id);
  await page.evaluate(() => {
    for (const [index, id] of ['adjacent-first', 'adjacent-second'].entries()) {
      const anchor = document.createElement('div');
      anchor.id = id;
      anchor.style.cssText = `position:fixed;left:${8 + index * 10}px;top:8px;width:22px;height:22px`;
      document.body.append(anchor);
    }
  });
  await frame.getByRole('switch', { name: 'Show feedback pins', exact: true }).click();
  await expect.poll(async () => (await pins(page)).length).toBe(2);
  const separated = async () => {
    const [first, second] = await pins(page);
    if (!first || !second) return false;
    return (
      first.x + first.width + 4 <= second.x ||
      second.x + second.width + 4 <= first.x ||
      first.y + first.height + 4 <= second.y ||
      second.y + second.height + 4 <= first.y
    );
  };
  await expect.poll(separated).toBe(true);
  await frame.getByRole('button', { name: 'Feedback', exact: false }).click();
  await frame.getByRole('button', { name: 'Sign out', exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect.poll(async () => (await pins(page)).find((pin) => pin.focused)?.text).toBe('1');
  await page.locator('#adjacent-second').evaluate((anchor) => {
    if (anchor instanceof HTMLElement) anchor.style.left = '8px';
  });
  await expect.poll(separated).toBe(true);
  expect((await pins(page)).find((pin) => pin.focused)?.text).toBe('1');
  await page.evaluate(() => {
    for (const [index, id] of ['adjacent-first', 'adjacent-second'].entries()) {
      const anchor = document.getElementById(id);
      if (!(anchor instanceof HTMLElement)) throw new Error('Adjacent anchor missing');
      anchor.style.left = `${1220 + index * 10}px`;
      anchor.style.width = '50px';
    }
  });
  await expect.poll(async () => (await pins(page)).find((pin) => pin.text === '1')?.x).toBe(1230);
  await expect.poll(async () => (await pins(page)).length).toBe(2);
  await expect.poll(separated).toBe(true);
  expect((await pins(page)).find((pin) => pin.focused)?.text).toBe('1');
  await page.keyboard.press('Enter');
  await expect(frame.getByText('Second adjacent feedback', { exact: true })).toBeVisible();
  await frame.getByRole('button', { name: 'Minimize toolbar' }).click();
  await clickPin(page, 2);
  await expect(frame.getByText('First adjacent feedback', { exact: true })).toBeVisible();
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
  await createThread(
    page,
    project.id,
    '#other-page-main',
    'Different page feedback',
    `${website}/other`,
  );
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

for (const clipping of [
  { name: 'paint containment', css: 'contain:paint' },
  { name: 'ancestor clip path', css: 'clip-path:inset(0)' },
]) {
  test(`paint-clip regression hides an invisible anchor under ${clipping.name}`, async ({
    page,
  }) => {
    await instrument(page);
    const project = await createProject(page);
    const thread = await createThread(
      page,
      project.id,
      '#paint-clip-anchor',
      'Paint-clipped feedback',
    );
    const frame = await openToolbar(page, project.id);
    await page.evaluate((css) => {
      const container = document.createElement('section');
      container.id = 'paint-clip-container';
      container.style.cssText = `position:fixed;left:100px;top:150px;width:120px;height:100px;${css}`;
      const anchor = document.createElement('button');
      anchor.id = 'paint-clip-anchor';
      anchor.textContent = 'Clipped anchor';
      anchor.style.cssText = 'position:absolute;left:150px;top:10px;width:80px;height:50px';
      container.append(anchor);
      document.body.append(container);
    }, clipping.css);
    await frame.getByRole('switch', { name: 'Show feedback pins', exact: true }).click();
    await expect
      .poll(async () =>
        (await pinMessages(page)).some((message) =>
          message.items.some((item) => item.threadId === thread.id),
        ),
      )
      .toBe(true);
    const rect = await page.locator('#paint-clip-anchor').boundingBox();
    expect(rect?.x).toBe(250);
    expect(rect?.width).toBe(80);
    await expect.poll(async () => (await pins(page)).length).toBe(0);
    await expect(frame.getByRole('button', { name: 'Back to feedback', exact: true })).toHaveCount(
      0,
    );
  });
}

test('paint containment clips each axis without suppressing visible children or layout-only containment', async ({
  page,
}) => {
  await instrument(page);
  const project = await createProject(page);
  await createThread(page, project.id, '#contained-anchor', 'Contained feedback');
  const frame = await openToolbar(page, project.id);
  await page.evaluate(() => {
    const container = document.createElement('section');
    container.id = 'contained-container';
    container.style.cssText =
      'position:fixed;left:100px;top:150px;width:120px;height:100px;contain:paint';
    const anchor = document.createElement('button');
    anchor.id = 'contained-anchor';
    anchor.textContent = 'Contained anchor';
    anchor.style.cssText = 'position:absolute;left:10px;top:10px;width:80px;height:50px';
    container.append(anchor);
    document.body.append(container);
  });
  await frame.getByRole('switch', { name: 'Show feedback pins', exact: true }).click();
  await expect.poll(async () => (await pins(page)).length).toBe(1);
  await clickPin(page, 1);
  await expect(frame.getByText('Contained feedback', { exact: true })).toBeVisible();
  await frame.getByRole('button', { name: 'Minimize toolbar', exact: true }).click();
  for (const contain of ['paint', 'strict', 'content']) {
    await page.locator('#contained-container').evaluate((container, contain) => {
      if (container instanceof HTMLElement) container.style.contain = contain;
    }, contain);
    await page.locator('#contained-anchor').evaluate((anchor) => {
      if (anchor instanceof HTMLElement) {
        anchor.style.left = '150px';
        anchor.style.top = '10px';
      }
    });
    await expect.poll(async () => (await pins(page)).length).toBe(0);
    await page.locator('#contained-anchor').evaluate((anchor) => {
      if (anchor instanceof HTMLElement) {
        anchor.style.left = '10px';
        anchor.style.top = '150px';
      }
    });
    await expect.poll(async () => (await pins(page)).length).toBe(0);
    await page.locator('#contained-anchor').evaluate((anchor) => {
      if (anchor instanceof HTMLElement) anchor.style.top = '10px';
    });
    await expect.poll(async () => (await pins(page)).length).toBe(1);
  }
  await page.locator('#contained-anchor').evaluate((anchor) => {
    if (anchor instanceof HTMLElement) {
      anchor.style.position = 'fixed';
      anchor.style.left = '150px';
    }
  });
  await expect.poll(async () => (await pins(page)).length).toBe(0);
  await page.locator('#contained-container').evaluate((container) => {
    if (container instanceof HTMLElement) container.style.contain = 'layout';
  });
  await page.locator('#contained-anchor').evaluate((anchor) => {
    if (anchor instanceof HTMLElement) anchor.style.left = '150px';
  });
  await expect.poll(async () => (await pins(page))[0]?.x).toBe(250);
  await page.locator('#contained-container').evaluate((container) => {
    if (container instanceof HTMLElement) {
      container.style.contain = 'none';
      container.style.contentVisibility = 'auto';
    }
  });
  await expect.poll(async () => (await pins(page)).length).toBe(0);
  await page.locator('#contained-anchor').evaluate((anchor) => {
    if (anchor instanceof HTMLElement) anchor.style.left = '10px';
  });
  await expect.poll(async () => (await pins(page)).length).toBe(1);
});

for (const clipping of [
  { name: 'clip path', property: 'clip-path', value: 'inset(100%)' },
  {
    name: 'image mask',
    property: 'mask-image',
    value: 'linear-gradient(transparent, transparent)',
  },
  { name: 'classic clip', property: 'clip', value: 'rect(0px, 0px, 0px, 0px)' },
]) {
  test(`paint-clip safety rejects ${clipping.name} on anchors and ancestors, including stale activation`, async ({
    page,
  }) => {
    await instrument(page);
    const project = await createProject(page);
    await createThread(page, project.id, '#shape-anchor', 'Shape-clipped feedback');
    const frame = await openToolbar(page, project.id);
    await page.evaluate(() => {
      const container = document.createElement('section');
      container.id = 'shape-container';
      container.style.cssText = 'position:fixed;left:100px;top:150px;width:120px;height:100px';
      const anchor = document.createElement('button');
      anchor.id = 'shape-anchor';
      anchor.textContent = 'Shape anchor';
      anchor.style.cssText = 'position:absolute;left:10px;top:10px;width:80px;height:50px';
      container.append(anchor);
      document.body.append(container);
    });
    await frame.getByRole('switch', { name: 'Show feedback pins', exact: true }).click();
    await expect.poll(async () => (await pins(page)).length).toBe(1);
    for (const id of ['shape-anchor', 'shape-container']) {
      await page.evaluate(
        ({ id, property, value }) => {
          const root: unknown = Reflect.get(window, 'pinTestRoot');
          if (!(root instanceof ShadowRoot)) throw new Error('Closed test root missing');
          const element = document.getElementById(id);
          const pin = root.querySelector('button');
          if (!element || !(pin instanceof HTMLButtonElement))
            throw new Error('Shape fixture missing');
          element.style.setProperty(property, value);
          // Activate the previously visible control before the debounced repaint.
          pin.click();
        },
        { id, property: clipping.property, value: clipping.value },
      );
      await expect.poll(async () => (await pins(page)).length).toBe(0);
      await expect(
        frame.getByRole('button', { name: 'Back to feedback', exact: true }),
      ).toHaveCount(0);
      await page.locator(`#${id}`).evaluate((element, property) => {
        if (element instanceof HTMLElement) element.style.removeProperty(property);
      }, clipping.property);
      await expect.poll(async () => (await pins(page)).length).toBe(1);
    }
    await clickPin(page, 1);
    await expect(frame.getByText('Shape-clipped feedback', { exact: true })).toBeVisible();
  });
}

for (const motion of ['css-transition', 'web-animation', 'css-without-registry']) {
  test(`sibling reflow regression tracks ${motion} at intermediate positions`, async ({ page }) => {
    await instrument(page);
    const project = await createProject(page);
    await createThread(page, project.id, '#motion-anchor', 'Sibling reflow feedback');
    const frame = await openToolbar(page, project.id);
    await page.evaluate((motion) => {
      if (motion === 'css-without-registry') {
        Object.defineProperty(document, 'getAnimations', { value: undefined, configurable: true });
        Object.defineProperty(document.documentElement, 'getAnimations', {
          value: undefined,
          configurable: true,
        });
      }
      const row = document.createElement('section');
      row.style.cssText = 'position:fixed;display:flex;left:20px;top:160px;width:500px;height:50px';
      const spacer = document.createElement('div');
      spacer.id = 'motion-spacer';
      spacer.style.cssText = 'width:0px;height:50px;flex-shrink:0;transition:width 3s linear';
      const anchor = document.createElement('button');
      anchor.id = 'motion-anchor';
      anchor.textContent = 'Anchor';
      anchor.style.cssText = 'width:100px;height:50px;flex-shrink:0';
      row.append(spacer, anchor);
      document.body.append(row);
    }, motion);
    await frame.getByRole('switch', { name: 'Show feedback pins', exact: true }).click();
    await expect.poll(async () => (await pins(page))[0]?.x).toBe(20);
    await page.locator('#motion-spacer').evaluate((spacer, motion) => {
      if (motion === 'web-animation') {
        spacer.animate([{ width: '0px' }, { width: '300px' }], {
          duration: 3000,
          fill: 'forwards',
        });
      } else if (spacer instanceof HTMLElement) spacer.style.width = '300px';
    }, motion);
    await expect
      .poll(async () => (await intermediatePosition(page, 'motion-anchor')).anchor)
      .toBeGreaterThan(100);
    const position = await intermediatePosition(page, 'motion-anchor');
    expect(position.anchor).toBeLessThan(320);
    await expect(page.locator('#motion-anchor')).toHaveCSS('width', '100px');
    await expect(page.locator('#motion-anchor')).toHaveCSS('height', '50px');
    expect(Math.abs(position.pin - position.anchor)).toBeLessThan(8);
  });
}

for (const layout of ['grid-ancestor-sibling', 'margin', 'font', 'custom-property']) {
  test(`outside-subtree layout motion tracks ${layout} without selector queries per frame`, async ({
    page,
  }) => {
    await instrument(page);
    const project = await createProject(page);
    await createThread(page, project.id, '#motion-anchor', 'Outside-subtree feedback');
    const frame = await openToolbar(page, project.id);
    if (layout === 'custom-property')
      await page.addStyleTag({
        content: '@property --opacity { syntax:"<length>"; inherits:false; initial-value:0px; }',
      });
    await page.evaluate((layout) => {
      const row = document.createElement('section');
      row.style.cssText = 'position:fixed;left:20px;top:160px;width:500px;height:50px;display:flex';
      const spacer = document.createElement('div');
      spacer.id = 'motion-spacer';
      spacer.style.cssText = 'width:0px;height:50px;flex-shrink:0';
      if (layout === 'font') {
        spacer.textContent = 'MMMM';
        spacer.style.width = 'auto';
        spacer.style.fontSize = '10px';
      }
      if (layout === 'custom-property') spacer.style.width = 'var(--opacity)';
      const anchor = document.createElement('button');
      anchor.id = 'motion-anchor';
      anchor.textContent = 'Anchor';
      anchor.style.cssText = 'width:100px;height:50px;flex-shrink:0';
      if (layout === 'grid-ancestor-sibling') {
        row.style.display = 'grid';
        row.style.gridTemplateColumns = 'auto 100px';
        row.style.justifyContent = 'start';
        const before = document.createElement('div');
        const after = document.createElement('div');
        before.append(spacer);
        after.append(anchor);
        row.append(before, after);
      } else row.append(spacer, anchor);
      document.body.append(row);
    }, layout);
    await frame.getByRole('switch', { name: 'Show feedback pins', exact: true }).click();
    await expect.poll(async () => (await pins(page)).length).toBe(1);
    const initial = await intermediatePosition(page, 'motion-anchor');
    await page.locator('#motion-spacer').evaluate((spacer, layout) => {
      const frames =
        layout === 'margin'
          ? [{ marginRight: '0px' }, { marginRight: '300px' }]
          : layout === 'font'
            ? [{ fontSize: '10px' }, { fontSize: '60px' }]
            : layout === 'custom-property'
              ? [{ '--opacity': '0px' }, { '--opacity': '300px' }]
              : [{ width: '0px' }, { width: '300px' }];
      spacer.animate(frames, { duration: 3000, fill: 'forwards' });
    }, layout);
    await expect
      .poll(async () => (await intermediatePosition(page, 'motion-anchor')).anchor)
      .toBeGreaterThan(initial.anchor + 40);
    const before = await counters(page);
    for (let sample = 0; sample < 3; sample++) {
      const position = await intermediatePosition(page, 'motion-anchor');
      expect(Math.abs(position.pin - position.anchor)).toBeLessThan(8);
      await waitForFrames(page, 100);
    }
    expect((await counters(page)).selectorReads - before.selectorReads).toBe(0);
    await expect(page.locator('#motion-anchor')).toHaveCSS('width', '100px');
    await expect(page.locator('#motion-anchor')).toHaveCSS('height', '50px');
  });
}

for (const registry of ['document', 'element', 'css-events']) {
  test(`unrelated infinite opacity decoration does not cause geometry sampling with ${registry} detection`, async ({
    page,
  }) => {
    await instrument(page);
    const project = await createProject(page);
    await createThread(page, project.id, '#motion-anchor', 'Static feedback');
    const frame = await openToolbar(page, project.id);
    await page.addStyleTag({
      content: '@keyframes unrelated-pin-opacity { from { opacity:1 } to { opacity:0.25 } }',
    });
    await page.evaluate((registry) => {
      if (registry !== 'document')
        Object.defineProperty(document, 'getAnimations', { value: undefined, configurable: true });
      if (registry === 'css-events')
        Object.defineProperty(document.documentElement, 'getAnimations', {
          value: undefined,
          configurable: true,
        });
      const anchor = document.createElement('button');
      anchor.id = 'motion-anchor';
      anchor.textContent = 'Static anchor';
      anchor.style.cssText = 'position:fixed;left:20px;top:160px;width:100px;height:50px';
      document.body.append(anchor);
    }, registry);
    await frame.getByRole('switch', { name: 'Show feedback pins', exact: true }).click();
    await expect.poll(async () => (await pins(page))[0]?.x).toBe(20);
    await page.evaluate(() => {
      const decoration = document.createElement('div');
      decoration.style.cssText =
        'position:fixed;left:700px;top:160px;width:50px;height:50px;background:red;animation:unrelated-pin-opacity 1s linear infinite';
      document.body.append(decoration);
    });
    await waitForFrames(page, 200);
    const before = await counters(page);
    await waitForFrames(page, 500);
    const after = await counters(page);
    expect(after.geometryReads - before.geometryReads).toBe(0);
    expect(after.selectorReads - before.selectorReads).toBe(0);
    expect((await pins(page))[0]?.x).toBe(20);
  });
}

test('outside-subtree CSS fallback follows ancestor-sibling motion and stops for pause, cancel and empty pins', async ({
  page,
}) => {
  await instrument(page);
  const project = await createProject(page);
  await createThread(page, project.id, '#motion-anchor', 'Fallback layout feedback');
  const frame = await openToolbar(page, project.id);
  await page.addStyleTag({
    content: '@keyframes sibling-pin-width { from { width:0px } to { width:300px } }',
  });
  await page.evaluate(() => {
    Object.defineProperty(document, 'getAnimations', { value: undefined, configurable: true });
    Object.defineProperty(document.documentElement, 'getAnimations', {
      value: undefined,
      configurable: true,
    });
    const row = document.createElement('section');
    row.style.cssText = 'position:fixed;left:20px;top:160px;width:500px;height:50px;display:flex';
    const spacer = document.createElement('div');
    spacer.id = 'motion-spacer';
    spacer.style.cssText = 'width:0px;height:50px;flex-shrink:0';
    const after = document.createElement('div');
    const anchor = document.createElement('button');
    anchor.id = 'motion-anchor';
    anchor.textContent = 'Anchor';
    anchor.style.cssText = 'width:100px;height:50px';
    after.append(anchor);
    row.append(spacer, after);
    document.body.append(row);
  });
  await frame.getByRole('switch', { name: 'Show feedback pins', exact: true }).click();
  await expect.poll(async () => (await pins(page))[0]?.x).toBe(20);
  await page.locator('#motion-spacer').evaluate((spacer) => {
    if (spacer instanceof HTMLElement)
      spacer.style.animation = 'sibling-pin-width 3s linear infinite';
  });
  await expect
    .poll(async () => (await intermediatePosition(page, 'motion-anchor')).anchor)
    .toBeGreaterThan(100);
  const position = await intermediatePosition(page, 'motion-anchor');
  expect(Math.abs(position.pin - position.anchor)).toBeLessThan(8);
  await page.locator('#motion-spacer').evaluate((spacer) => {
    if (spacer instanceof HTMLElement) spacer.style.animationPlayState = 'paused';
  });
  await waitForFrames(page, 200);
  const paused = await counters(page);
  await waitForFrames(page, 300);
  expect((await counters(page)).geometryReads - paused.geometryReads).toBe(0);
  await page.locator('#motion-spacer').evaluate((spacer) => {
    if (spacer instanceof HTMLElement) spacer.style.animationPlayState = 'running';
  });
  await expect
    .poll(async () => (await counters(page)).geometryReads)
    .toBeGreaterThan(paused.geometryReads);
  await page.locator('#motion-spacer').evaluate((spacer) => {
    if (spacer instanceof HTMLElement) spacer.style.animation = 'none';
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

test('keyboard focus remains on a pin while layout animations redraw its position', async ({
  page,
}) => {
  await instrument(page);
  const project = await createProject(page);
  await createThread(page, project.id, '[data-feedback-id="hero-button"]', 'Focused pin feedback');
  const frame = await openToolbar(page, project.id);
  await frame.getByRole('switch', { name: 'Show feedback pins', exact: true }).click();
  await expect.poll(async () => (await pins(page)).length).toBe(1);
  await frame.getByRole('button', { name: 'Feedback', exact: false }).click();
  await frame.getByRole('button', { name: 'Sign out', exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect.poll(async () => (await pins(page)).find((pin) => pin.focused)?.text).toBe('1');
  await page.evaluate(() => {
    const spacer = document.createElement('div');
    spacer.style.cssText = 'position:fixed;top:0;left:0;height:1px;pointer-events:none';
    document.body.append(spacer);
    spacer.animate([{ width: '0px' }, { width: '300px' }], {
      duration: 1000,
      iterations: Infinity,
    });
  });
  await page.waitForTimeout(200);
  expect((await pins(page)).find((pin) => pin.focused)?.outline).toBe('solid');
  await page.keyboard.press('Enter');
  await expect(frame.getByText('Focused pin feedback', { exact: true })).toBeVisible();
});

async function openLifecyclePins(page: Page, registry = 'document') {
  await instrument(page);
  const project = await createProject(page);
  await createThread(page, project.id, '#lifecycle-anchor', 'Animation lifecycle feedback');
  await page.route(new URL('/embed-module.js', service).href, async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      headers: { ...response.headers(), 'access-control-allow-origin': website },
    });
  });
  await page.goto(`${website}/`);
  await page.evaluate(
    async ({ registry, projectId, serviceOrigin, moduleAddress }) => {
      if (registry !== 'document')
        Object.defineProperty(document, 'getAnimations', { value: undefined, configurable: true });
      if (registry === 'ancestor')
        Object.defineProperty(document.documentElement, 'getAnimations', {
          value: undefined,
          configurable: true,
        });
      const row = document.createElement('section');
      row.style.cssText = 'position:fixed;display:flex;left:20px;top:160px;width:500px;height:50px';
      const spacer = document.createElement('div');
      spacer.id = 'lifecycle-spacer';
      spacer.style.cssText = 'width:0px;height:50px;flex-shrink:0';
      const anchor = document.createElement('button');
      anchor.id = 'lifecycle-anchor';
      anchor.textContent = 'Anchor';
      anchor.style.cssText = 'width:100px;height:50px;flex-shrink:0';
      row.append(spacer, anchor);
      document.body.append(row);
      const library: unknown = await import(moduleAddress);
      if (typeof library !== 'object' || library === null) throw new Error('Embed module missing');
      const mount: unknown = Reflect.get(library, 'mountFeedback');
      if (typeof mount !== 'function') throw new Error('Embed mount function missing');
      const controller: unknown = Reflect.apply(mount, null, [
        { server: serviceOrigin, projectId },
      ]);
      if (typeof controller !== 'object' || controller === null)
        throw new Error('Embed controller missing');
      const destroy: unknown = Reflect.get(controller, 'destroy');
      if (typeof destroy !== 'function') throw new Error('Embed destroy function missing');
      Object.defineProperty(window, 'pinTestLifecycleDestroy', {
        value() {
          Reflect.apply(destroy, controller, []);
        },
      });
    },
    {
      registry,
      projectId: project.id,
      serviceOrigin: service.origin,
      moduleAddress: new URL('/embed-module.js', service).href,
    },
  );
  await expect(page.locator('[data-feedback-host]')).toBeVisible({ timeout: 15_000 });
  const frame = page.frames().find((frame) => frame.url().includes('/toolbar?'));
  if (!frame) throw new Error('Toolbar frame missing');
  await expect(
    frame.getByRole('switch', { name: 'Show feedback pins', exact: true }),
  ).toBeEnabled();
  await frame.getByRole('switch', { name: 'Show feedback pins', exact: true }).click();
  await expect.poll(async () => (await pins(page))[0]?.x).toBe(20);
  await waitForFrames(page, 300);
  return frame;
}

test('short sibling Web Animation keeps the pin attached after finishing between registry polls', async ({
  page,
}) => {
  await openLifecyclePins(page);
  const reads = (await counters(page)).animationReads;
  // Start just after an idle poll so the complete 80ms animation fits in the 200ms gap.
  await page.waitForFunction(
    (reads) => {
      const value: unknown = Reflect.get(window, 'pinTestCounters');
      if (typeof value !== 'object' || value === null) return false;
      const current: unknown = Reflect.get(value, 'animationReads');
      return typeof current === 'number' && current > reads;
    },
    reads,
    { polling: 'raf' },
  );
  await page.locator('#lifecycle-spacer').evaluate(async (spacer) => {
    const motion = spacer.animate([{ width: '0px' }, { width: '300px' }], {
      duration: 80,
      fill: 'forwards',
    });
    await motion.finished;
  });
  await waitForFrames(page, 500);
  expect(await intermediatePosition(page, 'lifecycle-anchor')).toEqual({ anchor: 320, pin: 320 });
  const stable = await counters(page);
  await waitForFrames(page, 500);
  const after = await counters(page);
  expect(after.geometryReads - stable.geometryReads).toBe(0);
  expect(after.selectorReads - stable.selectorReads).toBe(0);
});

test('cancelling a paused sibling Web Animation returns the pin to its anchor', async ({
  page,
}) => {
  await openLifecyclePins(page);
  await page.locator('#lifecycle-spacer').evaluate((spacer) => {
    const motion = spacer.animate([{ width: '0px' }, { width: '300px' }], {
      duration: 3000,
      fill: 'forwards',
    });
    Object.defineProperty(window, 'pinTestLifecycleMotion', { value: motion });
  });
  await expect.poll(async () => (await pins(page))[0]?.x).toBeGreaterThan(80);
  await page.evaluate(() => {
    const motion: unknown = Reflect.get(window, 'pinTestLifecycleMotion');
    if (!(motion instanceof Animation)) throw new Error('Missing lifecycle animation');
    motion.pause();
  });
  await waitForFrames(page, 300);
  const paused = await intermediatePosition(page, 'lifecycle-anchor');
  expect(paused.anchor).toBeGreaterThan(80);
  expect(Math.abs(paused.pin - paused.anchor)).toBeLessThan(1);
  const stable = await counters(page);
  await waitForFrames(page, 300);
  expect((await counters(page)).geometryReads - stable.geometryReads).toBe(0);
  await page.evaluate(() => {
    const motion: unknown = Reflect.get(window, 'pinTestLifecycleMotion');
    if (!(motion instanceof Animation)) throw new Error('Missing lifecycle animation');
    motion.cancel();
  });
  await waitForFrames(page, 500);
  expect(await intermediatePosition(page, 'lifecycle-anchor')).toEqual({ anchor: 20, pin: 20 });
  const cancelled = await counters(page);
  await waitForFrames(page, 300);
  expect((await counters(page)).geometryReads - cancelled.geometryReads).toBe(0);
});

for (const registry of ['document', 'root', 'ancestor']) {
  test(`retained Web Animation seeks, timing, keyframes and effect removal reconcile with ${registry} registry`, async ({
    page,
  }) => {
    const frame = await openLifecyclePins(page, registry);
    await page.locator('#lifecycle-spacer').evaluate((spacer) => {
      const motion = spacer.animate([{ width: '0px' }, { width: '300px' }], {
        duration: 1000,
        fill: 'both',
      });
      motion.pause();
      motion.currentTime = 500;
      Object.defineProperty(window, 'pinTestLifecycleMotion', { value: motion });
    });
    await expect.poll(async () => (await pins(page))[0]?.x).toBe(170);
    await waitForFrames(page, 300);
    const before = await counters(page);
    await waitForFrames(page, 300);
    expect((await counters(page)).geometryReads - before.geometryReads).toBe(0);
    await page.evaluate(() => {
      const motion: unknown = Reflect.get(window, 'pinTestLifecycleMotion');
      if (!(motion instanceof Animation)) throw new Error('Missing lifecycle animation');
      motion.currentTime = 250;
    });
    await expect.poll(async () => (await pins(page))[0]?.x).toBe(95);
    await page.evaluate(() => {
      const motion: unknown = Reflect.get(window, 'pinTestLifecycleMotion');
      if (!(motion instanceof Animation)) throw new Error('Missing lifecycle animation');
      motion.effect?.updateTiming({ duration: 500 });
    });
    await expect.poll(async () => (await pins(page))[0]?.x).toBe(170);
    await page.evaluate(() => {
      const motion: unknown = Reflect.get(window, 'pinTestLifecycleMotion');
      if (!(motion instanceof Animation) || !(motion.effect instanceof KeyframeEffect))
        throw new Error('Missing lifecycle effect');
      motion.effect.setKeyframes([{ width: '0px' }, { width: '200px' }]);
    });
    await expect.poll(async () => (await pins(page))[0]?.x).toBe(120);
    await page.evaluate(() => {
      const motion: unknown = Reflect.get(window, 'pinTestLifecycleMotion');
      const spacer = document.getElementById('lifecycle-spacer');
      if (!(motion instanceof Animation) || !spacer) throw new Error('Missing lifecycle motion');
      motion.effect = new KeyframeEffect(spacer, [{ width: '0px' }, { width: '400px' }], {
        duration: 500,
        fill: 'both',
      });
    });
    await expect.poll(async () => (await pins(page))[0]?.x).toBe(220);
    await page.evaluate(() => {
      const motion: unknown = Reflect.get(window, 'pinTestLifecycleMotion');
      if (!(motion instanceof Animation)) throw new Error('Missing lifecycle animation');
      motion.effect = null;
    });
    await expect.poll(async () => (await pins(page))[0]?.x).toBe(20);
    await waitForFrames(page, 300);
    const removed = await counters(page);
    await waitForFrames(page, 300);
    expect((await counters(page)).geometryReads - removed.geometryReads).toBe(0);
    // Polling and frame updates throughout this sequence use the original anchors.
    expect(removed.selectorReads - before.selectorReads).toBe(0);
    await frame.getByRole('switch', { name: 'Hide feedback pins', exact: true }).click();
    await expect.poll(async () => (await pins(page)).length).toBe(0);
    const empty = await counters(page);
    await page.locator('#lifecycle-spacer').evaluate(async (spacer) => {
      await spacer.animate([{ width: '0px' }, { width: '300px' }], {
        duration: 80,
        fill: 'forwards',
      }).finished;
    });
    await waitForFrames(page, 400);
    expect(await counters(page)).toEqual(empty);
    await frame.getByRole('switch', { name: 'Show feedback pins', exact: true }).click();
    await expect.poll(async () => (await pins(page))[0]?.x).toBe(320);
    await waitForFrames(page, 300);
    await page.evaluate(() => {
      const destroy: unknown = Reflect.get(window, 'pinTestLifecycleDestroy');
      if (typeof destroy !== 'function') throw new Error('Lifecycle destroy function missing');
      Reflect.apply(destroy, null, []);
    });
    await expect(page.locator('[data-feedback-host]')).toHaveCount(0);
    await waitForFrames(page, 100);
    const destroyed = await counters(page);
    await page.locator('#lifecycle-spacer').evaluate((spacer) => {
      for (const animation of spacer.getAnimations()) animation.cancel();
    });
    await waitForFrames(page, 400);
    expect(await counters(page)).toEqual(destroyed);
  });
}

for (const registry of ['root', 'ancestor']) {
  test(`short finished and cancelled fill effects reconcile with ${registry} fallback registry`, async ({
    page,
  }) => {
    await openLifecyclePins(page, registry);
    await page.locator('#lifecycle-spacer').evaluate(async (spacer) => {
      const motion = spacer.animate([{ width: '0px' }, { width: '300px' }], {
        duration: 80,
        fill: 'forwards',
      });
      Object.defineProperty(window, 'pinTestLifecycleMotion', { value: motion });
      await motion.finished;
    });
    await expect.poll(async () => (await pins(page))[0]?.x).toBe(320);
    await waitForFrames(page, 300);
    const finished = await counters(page);
    await waitForFrames(page, 300);
    expect((await counters(page)).geometryReads - finished.geometryReads).toBe(0);
    await page.evaluate(() => {
      const motion: unknown = Reflect.get(window, 'pinTestLifecycleMotion');
      if (!(motion instanceof Animation)) throw new Error('Missing lifecycle animation');
      motion.pause();
      motion.currentTime = 40;
    });
    await expect.poll(async () => (await pins(page))[0]?.x).toBe(170);
    await page.evaluate(() => {
      const motion: unknown = Reflect.get(window, 'pinTestLifecycleMotion');
      if (!(motion instanceof Animation)) throw new Error('Missing lifecycle animation');
      motion.cancel();
    });
    await expect.poll(async () => (await pins(page))[0]?.x).toBe(20);
    expect(await intermediatePosition(page, 'lifecycle-anchor')).toEqual({ anchor: 20, pin: 20 });
    await waitForFrames(page, 300);
    const cancelled = await counters(page);
    await waitForFrames(page, 300);
    expect((await counters(page)).geometryReads - cancelled.geometryReads).toBe(0);
    expect(cancelled.selectorReads - finished.selectorReads).toBe(0);
  });
}

test('CSS lifecycle fallback still samples layout motion when every animation registry is unavailable', async ({
  page,
}) => {
  await openLifecyclePins(page, 'ancestor');
  await page.evaluate(() => {
    const spacer = document.getElementById('lifecycle-spacer');
    const anchor = document.getElementById('lifecycle-anchor');
    if (!(spacer instanceof HTMLElement) || !anchor || !spacer.parentElement)
      throw new Error('Missing lifecycle layout');
    for (const element of [document.body, spacer.parentElement, spacer, anchor])
      Object.defineProperty(element, 'getAnimations', { value: undefined, configurable: true });
    spacer.style.transition = 'width 3s linear';
  });
  await waitForFrames(page, 100);
  await page.locator('#lifecycle-spacer').evaluate((spacer) => {
    if (spacer instanceof HTMLElement) spacer.style.width = '300px';
  });
  await expect
    .poll(async () => (await intermediatePosition(page, 'lifecycle-anchor')).anchor)
    .toBeGreaterThan(100);
  const before = await counters(page);
  for (let sample = 0; sample < 3; sample++) {
    const position = await intermediatePosition(page, 'lifecycle-anchor');
    expect(position.anchor).toBeLessThan(320);
    expect(Math.abs(position.pin - position.anchor)).toBeLessThan(8);
    await waitForFrames(page, 100);
  }
  expect((await counters(page)).selectorReads - before.selectorReads).toBe(0);
  await page.locator('#lifecycle-spacer').evaluate((spacer) => {
    if (!(spacer instanceof HTMLElement)) throw new Error('Missing lifecycle spacer');
    spacer.style.transition = 'none';
    spacer.style.width = '0px';
  });
  await expect.poll(async () => (await pins(page))[0]?.x).toBe(20);
  await waitForFrames(page, 300);
  const stable = await counters(page);
  await waitForFrames(page, 300);
  expect((await counters(page)).geometryReads - stable.geometryReads).toBe(0);
});
