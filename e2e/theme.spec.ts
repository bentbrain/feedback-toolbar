import type { Frame, Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Theme } from '../src/shared/models.js';
import { projectSchema } from '../src/shared/models.js';
import { test, expect } from './fixtures.js';

type Mode = Theme['mode'];
async function projectFixture(page: Page, mode: Mode = 'system') {
  const signup = await page.request.post('/api/auth/sign-up/email', {
    data: {
      name: 'Theme review',
      email: `${randomUUID()}@example.invalid`,
      password: randomUUID(),
    },
  });
  expect(signup.status()).toBe(200);
  const created = await page.request.post('/api/projects', {
    data: { name: 'System theme fixture', origins: ['http://localhost:44321'], theme: { mode } },
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
  await page.goto('http://localhost:44321/');
  await page.addStyleTag({
    content:
      ':root{color-scheme:light dark}body{background:#fff}@media(prefers-color-scheme:dark){body{background:#000}}',
  });
  await page.evaluate(
    ({ projectId, override }) => {
      window.addEventListener('message', (event: MessageEvent<unknown>) => {
        if (
          event.origin !== 'http://localhost:44320' ||
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
      script.src = 'http://localhost:44320/embed.js';
      script.dataset.project = projectId;
      if (override) script.dataset.mode = override;
      document.head.append(script);
    },
    { projectId, override },
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
    element.style.colorScheme = 'light';
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
  await frame.evaluate(() => {
    for (const message of [
      { origin: 'https://unregistered.example', source: window.parent },
      { origin: 'http://localhost:44321', source: window },
    ]) {
      window.dispatchEvent(
        new MessageEvent('message', {
          ...message,
          data: { type: 'feedback:system-theme', systemMode: 'light' },
        }),
      );
    }
  });
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
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
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
