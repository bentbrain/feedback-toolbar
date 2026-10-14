import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { z } from 'zod';
import { test, expect } from './fixtures.js';
import { projectSchema } from '../src/shared/models.js';

declare const chrome: {
  tabs: {
    query(options: { url: string }): Promise<{ id?: number }[]>;
    setZoom(tabId: number, zoomFactor: number): Promise<void>;
    getZoom(tabId: number): Promise<number>;
  };
};

const projectName = 'Feedback toolbar demo';
const longProjectName = `iPhone Japan ${'Project'.repeat(9)}`;
const userName = `Alex ${'Morgan'.repeat(12)}`;

async function box(element: Locator) {
  const bounds = await element.boundingBox();
  if (!bounds) throw new Error('Expected visible rendered bounds.');
  return bounds;
}

let cookies: Awaited<ReturnType<BrowserContext['cookies']>> = [];

test.beforeEach(async ({ page, baseURL }) => {
  if (!baseURL) throw new Error('Dashboard tests require the configured local server.');
  const context = page.context();
  const request = context.request;
  expect(
    (
      await request.post('/api/auth/sign-up/email', {
        data: { name: userName, email: `${randomUUID()}@example.invalid`, password: randomUUID() },
      })
    ).status(),
  ).toBe(200);
  for (const name of [projectName, longProjectName]) {
    const result = await request.post('/api/projects', {
      data: { name, origins: ['http://localhost:44321'] },
    });
    expect(result.status()).toBe(201);
    const project = z.object({ project: projectSchema }).parse(await result.json()).project;
    expect(
      (
        await request.post(`/api/projects/${project.id}/threads`, {
          data: {
            body: `Preserve iPhone Japan ${'UnbrokenFeedback'.repeat(15)}`,
            context: {
              url: `http://localhost:44321/${'iPhone'.repeat(15)}`,
              viewport: { width: 1280, height: 800 },
              deployment: null,
              anchor: {
                selector: 'button',
                feedbackId: null,
                tag: 'button',
                text: 'iPhone Japan',
                label: '',
                rect: { x: 0, y: 0, width: 100, height: 30 },
              },
            },
          },
        })
      ).status(),
    ).toBe(201);
  }
  cookies = await context.cookies();
});

test.beforeEach(async ({ page, context }) => {
  await context.addCookies(cookies);
  // A named connection exercises the agent row without creating or reading an agent secret.
  await page.route('**/api/projects/*/credentials', (route) =>
    route.fulfill({
      json: {
        credentials: [
          {
            id: 'layout-agent',
            name: 'iPhone Japan ' + 'Agent'.repeat(12),
            expiresAt: 1900000000000,
            createdAt: '2026-10-14T00:00:00Z',
          },
        ],
      },
    }),
  );
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Feedback', exact: true })).toBeVisible();
});

async function expectUnclippedControls(page: Page) {
  const viewport = await page.evaluate(() => ({
    width: innerWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(viewport.scroll).toBeLessThanOrEqual(viewport.width);
  const clipped = await page.locator('main').evaluate((main) => {
    const failures: string[] = [];
    for (const control of main.querySelectorAll('button, input, textarea, [role="combobox"]')) {
      if (control.getAttribute('aria-hidden') === 'true') continue;
      const bounds = control.getBoundingClientRect();
      if (!bounds.width || !bounds.height) continue;
      let left = 0;
      let right = innerWidth;
      for (let ancestor = control.parentElement; ancestor; ancestor = ancestor.parentElement) {
        if (['hidden', 'clip', 'auto', 'scroll'].includes(getComputedStyle(ancestor).overflowX)) {
          const clip = ancestor.getBoundingClientRect();
          left = Math.max(left, clip.left);
          right = Math.min(right, clip.right);
        }
      }
      if (bounds.left < left - 1 || bounds.right > right + 1)
        failures.push(
          `${control.getAttribute('aria-label') ?? control.textContent.trim()}: ${bounds.left}..${bounds.right}, visible ${left}..${right}`,
        );
    }
    return failures;
  });
  expect(clipped).toEqual([]);
}

const sections = [
  { navigation: 'Feedback', heading: 'Feedback' },
  { navigation: 'Installation', heading: 'Installation' },
  { navigation: 'Appearance', heading: 'Appearance' },
  { navigation: 'People', heading: 'Members' },
  { navigation: 'Agents', heading: 'Agents' },
  { navigation: 'Account security', heading: 'Account security' },
];

for (const viewport of [
  { width: 1920, height: 1080 },
  { width: 1280, height: 800 },
  { width: 1024, height: 768 },
  { width: 768, height: 1024 },
  // 1280x800 at 200% browser zoom reflows into this CSS viewport.
  { width: 640, height: 400 },
  { width: 390, height: 844 },
  { width: 320, height: 568 },
]) {
  test(`all dashboard sections fit ${viewport.width}x${viewport.height} with long names`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    const mobile = viewport.width < 1024;
    const toggle = page.getByRole('button', { name: 'Toggle navigation' });
    if (mobile) await toggle.click();
    const project = page.getByRole('combobox', { name: 'Project', exact: true });
    await project.click();
    const option = page.getByRole('option', { name: longProjectName, exact: true });
    await expect(option).toBeVisible();
    const popup = await box(page.locator('[data-slot="select-content"]'));
    expect(popup.x).toBeGreaterThanOrEqual(0);
    expect(popup.x + popup.width).toBeLessThanOrEqual(viewport.width);
    expect(await option.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    await option.click();
    const sidebar = await box(
      page.locator(
        mobile ? '[data-slot="sidebar"][data-mobile]' : '[data-slot="sidebar-container"]',
      ),
    );
    const selector = await box(project);
    expect(selector.x + selector.width).toBeLessThanOrEqual(sidebar.x + sidebar.width - 8);
    const account = page.getByRole('button', { name: 'Account menu', exact: true });
    await expect(account.locator('[data-feedback-content]')).toHaveText(userName);
    await expect(account.locator('[data-feedback-content]')).toHaveCSS('text-transform', 'none');
    await account.click();
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    await expect.poll(async () => (await box(menu)).x).toBeGreaterThanOrEqual(0);
    const menuBounds = await box(menu);
    expect(menuBounds.x + menuBounds.width).toBeLessThanOrEqual(viewport.width);
    expect(menuBounds.y).toBeGreaterThanOrEqual(0);
    expect(menuBounds.y + menuBounds.height).toBeLessThanOrEqual(viewport.height);
    await page.keyboard.press('Escape');
    await expect(account).toBeFocused();
    if (mobile) {
      await page.keyboard.press('Escape');
      await expect(toggle).toBeFocused();
    }
    const colors: ('light' | 'dark')[] = ['light', 'dark'];
    for (const colorScheme of colors) {
      await page.emulateMedia({ colorScheme });
      for (const section of sections) {
        if (mobile) await toggle.click();
        await page
          .getByRole('navigation', { name: 'Project navigation' })
          .getByRole('button', { name: section.navigation, exact: true })
          .click();
        await expect(
          page.getByRole('heading', { name: section.heading, exact: true }),
        ).toBeVisible();
        if (mobile) await expect(page.getByRole('dialog')).toBeHidden();
        await expectUnclippedControls(page);
        const content = await box(page.locator('[data-slot="dashboard-content"]'));
        const main = await box(page.getByRole('main'));
        expect(content.width).toBe(Math.min(main.width, 1280));
        if (section.navigation === 'People') {
          const role = page.getByRole('combobox', { name: 'Project role' });
          await role.click();
          await expect(
            page.getByRole('option', { name: 'Owner · Manage project and agent work' }),
          ).toBeVisible();
          await page.keyboard.press('Escape');
        }
        if (section.navigation === 'Feedback') {
          const message = page.getByText(`Preserve iPhone Japan ${'UnbrokenFeedback'.repeat(15)}`, {
            exact: true,
          });
          await expect(message).toHaveCSS('text-transform', 'none');
          await message.click();
          const conversation = page.getByRole('dialog');
          await expect(conversation).toBeVisible();
          const conversationBounds = await box(conversation);
          expect(conversationBounds.x).toBeGreaterThanOrEqual(0);
          expect(conversationBounds.x + conversationBounds.width).toBeLessThanOrEqual(
            viewport.width,
          );
          expect(
            await conversation.evaluate((element) => element.scrollWidth <= element.clientWidth),
          ).toBe(true);
          await expect(
            conversation.getByRole('button', { name: 'Reply', exact: true }),
          ).toBeVisible();
          await page.keyboard.press('Escape');
        }
      }
    }
  });
}

test('sidebar toggles by keyboard and keeps mobile navigation scrollable in a short viewport', async ({
  page,
}) => {
  const toggle = page.getByRole('button', { name: 'Toggle navigation' });
  await toggle.focus();
  await page.keyboard.press('Control+b');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  expect((await box(page.getByRole('main'))).x).toBe(0);
  await page.keyboard.press('Control+b');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await page.setViewportSize({ width: 640, height: 320 });
  await toggle.click();
  const dialog = page.getByRole('dialog', { name: 'Navigation' });
  await expect(dialog).toBeVisible();
  for (let index = 0; index < 12; index++) {
    await page.keyboard.press('Tab');
    await expect
      .poll(() => dialog.evaluate((element) => element.contains(document.activeElement)))
      .toBe(true);
  }
  expect(await dialog.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(
    true,
  );
  await dialog.getByRole('button', { name: 'Account security', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Account security', exact: true })).toBeVisible();
  await expect(dialog).toBeHidden();
  await expect(toggle).toBeFocused();
});

test('native 200% browser zoom reflows dashboard sections and keeps navigation usable', async ({
  baseURL,
}) => {
  if (!baseURL) throw new Error('Dashboard tests require the configured local server.');
  await mkdir('.data', { recursive: true });
  const extension = await mkdtemp(resolve('.data/dashboard-zoom-'));
  // Chromium's extension API changes real browser zoom, unlike CSS zoom or pinch scaling.
  await writeFile(
    resolve(extension, 'manifest.json'),
    JSON.stringify({
      manifest_version: 3,
      name: 'Dashboard zoom regression',
      version: '1.0',
      permissions: ['tabs'],
      background: { service_worker: 'worker.js' },
    }),
  );
  await writeFile(
    resolve(extension, 'worker.js'),
    'chrome.runtime.onInstalled.addListener(() => {});',
  );
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1280, height: 800 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  try {
    await context.addCookies(cookies);
    const page = await context.newPage();
    await page.goto(baseURL);
    await expect(page.getByRole('heading', { name: 'Feedback', exact: true })).toBeVisible();
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const zoom = z.number().parse(
      await worker.evaluate(async (url) => {
        const tabs = await chrome.tabs.query({ url });
        const tab = tabs[0];
        if (tab?.id === undefined) throw new Error('Dashboard tab missing');
        await chrome.tabs.setZoom(tab.id, 2);
        return chrome.tabs.getZoom(tab.id);
      }, `${baseURL}/*`),
    );
    expect(zoom).toBe(2);
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(640);
    expect(await page.evaluate(() => devicePixelRatio)).toBe(2);
    for (const section of sections) {
      await page.getByRole('button', { name: 'Toggle navigation' }).click();
      await page
        .getByRole('navigation', { name: 'Project navigation' })
        .getByRole('button', { name: section.navigation, exact: true })
        .click();
      await expect(page.getByRole('heading', { name: section.heading, exact: true })).toBeVisible();
      await expectUnclippedControls(page);
    }
  } finally {
    await context.close();
    await rm(extension, { recursive: true, force: true });
  }
});

test('project selector stays inside the desktop sidebar at its rendered width', async ({
  page,
}) => {
  const sidebar = page.locator('aside, [data-slot="sidebar-container"]').first();
  const project = page.getByRole('combobox', { name: 'Project', exact: true });
  for (const name of [projectName, longProjectName]) {
    await project.click();
    await page.getByRole('option', { name, exact: true }).click();
    const panel = await box(sidebar);
    const trigger = await box(project);
    expect(trigger.x + trigger.width, `Project ${name} overflows the sidebar`).toBeLessThanOrEqual(
      panel.x + panel.width - 8,
    );
    expect(trigger.x).toBeGreaterThanOrEqual(panel.x + 8);
    const value = project.locator('[data-slot="select-value"]');
    const label = await box(value);
    expect(label.x + label.width).toBeLessThan(trigger.x + trigger.width - 16);
    await expect(value).toHaveText(name);
  }
});

test('account menu opens beside the desktop sidebar without covering its trigger', async ({
  page,
}) => {
  const sidebar = page.locator('aside, [data-slot="sidebar-container"]').first();
  const trigger = page.getByRole('button', { name: 'Account menu', exact: true });
  await trigger.click();
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  // Wait for the opening animation before checking actual geometry.
  await expect
    .poll(async () => (await box(menu)).x)
    .toBeGreaterThanOrEqual((await box(sidebar)).x + (await box(sidebar)).width + 4);
  const popup = await box(menu);
  const anchor = await box(trigger);
  expect(popup.y).toBeLessThan(anchor.y + anchor.height);
  expect(popup.y + popup.height).toBeGreaterThan(anchor.y);
  expect(popup.x + popup.width).toBeLessThanOrEqual(page.viewportSize()?.width ?? 0);
  await expect(page.getByRole('menuitem', { name: 'Sign out' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
});
