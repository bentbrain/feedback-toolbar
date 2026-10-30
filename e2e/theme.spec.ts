import type { Frame, Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Theme } from '../src/shared/models.js';
import { projectSchema } from '../src/shared/models.js';
import { test, expect } from './fixtures.js';

const serviceOrigin = new URL(`http://localhost:${process.env.FEEDBACK_E2E_PORT ?? '44320'}`)
  .origin;
const website = new URL(serviceOrigin);
website.port = String(Number(website.port) + 1);

type Mode = Theme['mode'];
async function projectFixture(page: Page, mode: Mode = 'system', appearance: Partial<Theme> = {}) {
  const signup = await page.request.post('/api/auth/sign-up/email', {
    data: {
      name: 'Theme review',
      email: `${randomUUID()}@example.invalid`,
      password: randomUUID(),
    },
  });
  expect(signup.status()).toBe(200);
  const created = await page.request.post('/api/projects', {
    data: {
      name: 'System theme fixture',
      origins: [website.origin],
      theme: { ...appearance, mode },
    },
  });
  return z.object({ project: projectSchema }).parse(await created.json()).project;
}
async function openToolbar(
  page: Page,
  projectId: string,
  override?: Mode,
  waitVisible = true,
): Promise<Frame> {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(website.href);
  await page.addStyleTag({
    content:
      ':root{color-scheme:light dark}body{background:#fff}@media(prefers-color-scheme:dark){body{background:#000}}',
  });
  await page.evaluate(
    ({ projectId, override, serviceOrigin, embedUrl }) => {
      window.addEventListener('message', (event: MessageEvent<unknown>) => {
        if (
          event.origin !== serviceOrigin ||
          typeof event.data !== 'object' ||
          event.data === null ||
          !('type' in event.data) ||
          event.data.type !== 'feedback:theme'
        )
          return;
        const data = event.data;
        if ('theme' in data)
          document.documentElement.setAttribute('data-toolbar-theme', JSON.stringify(data.theme));
      });
      const script = document.createElement('script');
      script.src = embedUrl;
      script.dataset.project = projectId;
      if (override) script.dataset.mode = override;
      document.head.append(script);
    },
    { projectId, override, serviceOrigin, embedUrl: new URL('/embed.js', serviceOrigin).href },
  );
  await expect
    .poll(() => page.frames().some((frame) => frame.url().includes('/toolbar?')))
    .toBe(true);
  const frame = page.frames().find((frame) => frame.url().includes('/toolbar?'));
  if (!frame) throw new Error('Toolbar frame missing');
  await expect(frame.locator('html')).toHaveAttribute('data-mode', /light|dark/);
  if (waitVisible) await expect(page.locator('[data-feedback-host]')).toBeVisible();
  return frame;
}
async function expectMode(frame: Frame, mode: 'light' | 'dark') {
  await expect(frame.locator('html')).toHaveAttribute('data-mode', mode);
  await expect(
    frame.getByRole('button', { name: 'Feedback', exact: false }).locator('..'),
  ).toHaveCSS('background-color', mode === 'dark' ? 'rgb(0, 0, 0)' : 'rgb(255, 255, 255)');
}
async function constrainFrameToLight(frame: Frame) {
  // Reproduce an embedding/browser color-scheme mismatch using real CSS and native media queries.
  const element = await frame.frameElement();
  await element.evaluate((element) => {
    if (!(element instanceof HTMLIFrameElement)) throw new Error('Toolbar iframe missing');
    const root = element.getRootNode();
    if (!(root instanceof ShadowRoot)) throw new Error('Toolbar shadow root missing');
    const style = document.createElement('style');
    // Hold the native mismatch even when the loader synchronizes its inline scheme.
    style.textContent = 'iframe { color-scheme: light !important; }';
    root.append(style);
  });
  if (!(await element.isVisible())) return;
  await frame.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            resolve();
          }),
        ),
      ),
  );
}

test('system toolbar follows the dark parent when the iframe preference is light', async ({
  page,
}, testInfo) => {
  // The additional config exercises Chromium's native preference, without emulating every frame.
  if (testInfo.project.name !== 'chromium-native-dark')
    await page.emulateMedia({ colorScheme: 'dark' });
  const project = await projectFixture(page);
  const frame = await openToolbar(page, project.id);
  await constrainFrameToLight(frame);
  await expect
    .poll(() => frame.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches))
    .toBe(false);
  const parent = await page.evaluate(() => ({
    dark: matchMedia('(prefers-color-scheme: dark)').matches,
    scheme: getComputedStyle(document.documentElement).colorScheme,
    background: getComputedStyle(document.body).backgroundColor,
  }));
  const embedded = await frame.evaluate(() => ({
    dark: matchMedia('(prefers-color-scheme: dark)').matches,
    mode: document.documentElement.dataset.mode,
    background: getComputedStyle(
      document.querySelector('[data-slot=button]')?.parentElement ?? document.body,
    ).backgroundColor,
  }));
  await testInfo.attach('theme-resolution', {
    body: JSON.stringify({ parent, embedded }),
    contentType: 'application/json',
  });
  expect(parent.dark).toBe(true);
  expect(embedded.dark).toBe(false);
  await expectMode(frame, 'dark');
  await expect
    .poll(async () => {
      const value = await page.locator('html').getAttribute('data-toolbar-theme');
      return value
        ? z
            .object({ mode: z.string(), accent: z.string(), radius: z.string() })
            .parse(JSON.parse(value))
        : null;
    })
    .toEqual({ mode: 'dark', accent: '#2870ff', radius: 'square' });
  // Neither a different origin nor another window at the registered origin can set the preference.
  await frame.evaluate((websiteOrigin) => {
    for (const message of [
      { origin: 'https://unregistered.example', source: window.parent },
      { origin: websiteOrigin, source: window },
    ]) {
      window.dispatchEvent(
        new MessageEvent('message', {
          ...message,
          data: { type: 'feedback:system-theme', systemMode: 'light' },
        }),
      );
    }
  }, website.origin);
  await expectMode(frame, 'dark');
});

for (const initial of ['light', 'dark']) {
  test(`system toolbar starts ${initial} and follows live parent preference changes`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: initial === 'dark' ? 'dark' : 'light' });
    const project = await projectFixture(page);
    const frame = await openToolbar(page, project.id);
    await expectMode(frame, initial === 'dark' ? 'dark' : 'light');
    await constrainFrameToLight(frame);
    for (const mode of ['light', 'dark', 'light']) {
      await page.emulateMedia({ colorScheme: mode === 'dark' ? 'dark' : 'light' });
      await expectMode(frame, mode === 'dark' ? 'dark' : 'light');
    }
  });
}

const explicitThemes: { saved: Mode; override?: Mode; expected: 'light' | 'dark' }[] = [
  { saved: 'light', expected: 'light' },
  { saved: 'dark', expected: 'dark' },
  { saved: 'system', override: 'light', expected: 'light' },
  { saved: 'light', override: 'dark', expected: 'dark' },
];
for (const { saved, override, expected } of explicitThemes) {
  test(`saved ${saved}, override ${override ?? 'absent'} preserves explicit ${expected} mode`, async ({
    page,
  }) => {
    const project = await projectFixture(page, saved);
    const frame = await openToolbar(page, project.id, override);
    for (const mode of ['dark', 'light']) {
      await page.emulateMedia({ colorScheme: mode === 'dark' ? 'dark' : 'light' });
      await expectMode(frame, expected);
    }
  });
}

test('standalone appearance preview follows system changes and preserves explicit selections', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await projectFixture(page);
  await page.goto('/');
  await page.getByRole('link', { name: 'Appearance', exact: true }).click();
  const preview = page
    .getByText('Could we give this button a little more space?', { exact: true })
    .locator('xpath=ancestor::*[@data-mode][1]');
  for (const mode of ['light', 'dark', 'light']) {
    await page.emulateMedia({ colorScheme: mode === 'dark' ? 'dark' : 'light' });
    await expect(preview).toHaveAttribute('data-mode', mode);
  }
  await page.getByRole('tab', { name: 'dark', exact: true }).click();
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(preview).toHaveAttribute('data-mode', 'dark');
  await page.getByRole('tab', { name: 'light', exact: true }).click();
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(preview).toHaveAttribute('data-mode', 'light');
});

test('system embed override follows the parent instead of the saved dark mode', async ({
  page,
}) => {
  const project = await projectFixture(page, 'dark');
  const frame = await openToolbar(page, project.id, 'system');
  for (const mode of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: mode === 'dark' ? 'dark' : 'light' });
    await expectMode(frame, mode === 'dark' ? 'dark' : 'light');
  }
});

for (const saved of ['system', 'light']) {
  test(`initial visibility waits for saved ${saved} theme and parent configuration`, async ({
    page,
  }, testInfo) => {
    if (testInfo.project.name !== 'chromium-native-dark')
      await page.emulateMedia({ colorScheme: 'dark' });
    const project = await projectFixture(page, saved === 'system' ? 'system' : 'light');
    let release: () => void = () => {
      throw new Error('Theme gate is not initialized');
    };
    const metadata = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/api/embed/**', async (route) => {
      await metadata;
      await route.continue();
    });
    const listed = page.waitForResponse(
      (response) =>
        response.request().method() === 'GET' &&
        response.url().includes(`/api/projects/${project.id}/threads?`),
    );
    try {
      const frame = await openToolbar(page, project.id, undefined, false);
      await constrainFrameToLight(frame);
      expect((await listed).status()).toBe(200);
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() =>
              requestAnimationFrame(() => {
                resolve();
              }),
            ),
          ),
      );
      await expect(page.locator('[data-feedback-host]')).toHaveCSS('display', 'none');
      release();
      await expect(page.locator('[data-feedback-host]')).toBeVisible();
      await expectMode(frame, saved === 'system' ? 'dark' : 'light');
    } finally {
      release();
    }
  });
}

test('metadata errors stay visible after trusted parent theme configuration', async ({
  page,
}, testInfo) => {
  if (testInfo.project.name !== 'chromium-native-dark')
    await page.emulateMedia({ colorScheme: 'dark' });
  const project = await projectFixture(page);
  await page.route('**/api/embed/**', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Theme metadata is temporarily unavailable.' }),
    }),
  );
  const frame = await openToolbar(page, project.id);
  await expect(frame.getByRole('alert')).toHaveText('Theme metadata is temporarily unavailable.');
  await expect(frame.locator('html')).toHaveAttribute('data-mode', 'dark');
});

for (const saved of ['system', 'light', 'dark'] satisfies Mode[]) {
  test(`toolbar canvas stays transparent with saved ${saved} mode`, async ({ page }, testInfo) => {
    if (testInfo.project.name !== 'chromium-native-dark')
      await page.emulateMedia({ colorScheme: 'dark' });
    const project = await projectFixture(page, saved, { accent: '#292f29', radius: 'soft' });
    const frame = await openToolbar(page, project.id);
    await page.evaluate(() => {
      const backdrop = document.createElement('div');
      backdrop.style.cssText = 'position:fixed;inset:0;background:#123456;z-index:2147483646';
      document.body.append(backdrop);
    });
    for (const [index, system] of ['dark', 'light', 'dark'].entries()) {
      if (index > 0) await page.emulateMedia({ colorScheme: system === 'dark' ? 'dark' : 'light' });
      const mode = saved === 'system' ? system : saved;
      await expectMode(frame, mode === 'dark' ? 'dark' : 'light');
      await expect(frame.locator('html')).toHaveCSS('color-scheme', mode);
      await expect
        .poll(async () =>
          (await frame.frameElement()).evaluate((element) => {
            if (!(element instanceof HTMLIFrameElement)) throw new Error('Toolbar iframe missing');
            return getComputedStyle(element).colorScheme;
          }),
        )
        .toBe(mode);
      const screenshot = await page.locator('[data-feedback-host]').screenshot({
        scale: 'css',
        path: testInfo.outputPath(`canvas-${system}-${index}.png`),
      });
      await testInfo.attach(`canvas-${system}-${index}`, {
        body: screenshot,
        contentType: 'image/png',
      });
      const pixels = await page.evaluate(async (base64) => {
        const image = new Image();
        image.src = `data:image/png;base64,${base64}`;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Missing screenshot pixel context');
        context.drawImage(image, 0, 0);
        return [
          [1, 1],
          [image.width - 2, image.height - 2],
          [4, 4],
        ].map(([x = 0, y = 0]) => Array.from(context.getImageData(x, y, 1, 1).data));
      }, screenshot.toString('base64'));
      expect(pixels).toEqual([
        [18, 52, 86, 255],
        [18, 52, 86, 255],
        [18, 52, 86, 255],
      ]);
    }
  });
}
