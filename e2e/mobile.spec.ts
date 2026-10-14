import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { projectSchema } from '../src/shared/models.js';
import { test, expect } from './fixtures.js';

test.use({ hasTouch: true });

test('sign-in and sign-up fit a small phone and remain reachable in a reduced viewport', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  for (const signup of [false, true]) {
    if (signup) await page.getByRole('button', { name: 'Create an account' }).click();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollHeight - innerHeight))
      .toBe(0);
    for (const control of await page.locator('input, form button').all()) {
      const bounds = await control.boundingBox();
      expect.soft(bounds?.height).toBeGreaterThanOrEqual(44);
    }
  }
  await page.setViewportSize({ width: 320, height: 300 });
  const name = page.getByRole('textbox', { name: 'Name', exact: true });
  await name.scrollIntoViewIfNeeded();
  await expect(name).toBeInViewport();
  const submit = page.getByRole('button', { name: 'Create account', exact: true });
  await submit.scrollIntoViewIfNeeded();
  await expect(submit).toBeInViewport();
});

test('project creation stays inside a short viewport with readable fields and reachable actions', async ({
  page,
}) => {
  await page.setViewportSize({ width: 640, height: 320 });
  expect(
    (
      await page.request.post('/api/auth/sign-up/email', {
        data: {
          name: 'Mobile review',
          email: `${randomUUID()}@example.invalid`,
          password: randomUUID(),
        },
      })
    ).status(),
  ).toBe(200);
  await page.goto('/');
  await page.getByRole('button', { name: 'Create your first project' }).click();
  const dialog = page.getByRole('dialog', { name: 'New project' });
  await expect(dialog).toBeVisible();
  await expect
    .poll(() => dialog.evaluate((element) => element.getBoundingClientRect().top))
    .toBeGreaterThanOrEqual(16);
  const bounds = await dialog.boundingBox();
  expect((bounds?.y ?? 0) + (bounds?.height ?? 0)).toBeLessThanOrEqual(304);
  await expect(page.getByRole('textbox', { name: 'Website origins' })).toHaveCSS(
    'font-size',
    '16px',
  );
  await page.getByRole('textbox', { name: 'Project name' }).fill('Mobile project');
  await dialog.getByRole('button', { name: 'Create project', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Installation', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Toggle navigation' }).click();
  const navigation = page.getByRole('dialog', { name: 'Navigation' });
  const scrollArea = navigation.locator('[data-slot="sidebar-content"]');
  expect((await scrollArea.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  const security = navigation.getByRole('button', { name: 'Account security', exact: true });
  await security.scrollIntoViewIfNeeded();
  await expect(security).toBeInViewport({ ratio: 1 });
  await security.click();
  await expect(navigation).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Account security', exact: true })).toBeVisible();
});

test('GitHub sign-in fits a small phone in both appearances', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.route('**/api/config', (route) =>
    route.fulfill({
      json: {
        demoUrl: 'http://localhost:44321',
        allowSignup: false,
        github: true,
        localPassword: false,
      },
    }),
  );
  await page.goto('/');
  const colorSchemes: ('light' | 'dark')[] = ['light', 'dark'];
  for (const colorScheme of colorSchemes) {
    await page.emulateMedia({ colorScheme });
    await expect(page.getByRole('button', { name: 'Continue with GitHub' })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollHeight - innerHeight)).toBe(0);
  }
});

test('long replies and toolbar controls stay reachable on narrow and short touch screens', async ({
  page,
  baseURL,
}) => {
  if (!baseURL) throw new Error('Missing fixture origin');
  const website = new URL(baseURL);
  website.port = String(Number(website.port) + 1);
  expect(
    (
      await page.request.post('/api/auth/sign-up/email', {
        data: {
          name: 'Mobile ' + 'Reviewer'.repeat(6),
          email: `${randomUUID()}@example.invalid`,
          password: randomUUID(),
        },
      })
    ).status(),
  ).toBe(200);
  const project = z.object({ project: projectSchema }).parse(
    await (
      await page.request.post('/api/projects', {
        data: { name: 'Mobile ' + 'Project'.repeat(8), origins: [website.origin] },
      })
    ).json(),
  ).project;
  expect(
    (
      await page.request.post(`/api/projects/${project.id}/threads`, {
        data: {
          body: 'Mobile conversation',
          context: {
            url: website.href,
            viewport: { width: 320, height: 568 },
            deployment: null,
            anchor: {
              selector: 'h1',
              feedbackId: null,
              tag: 'h1',
              text: 'Heading',
              label: '',
              rect: { x: 20, y: 40, width: 120, height: 36 },
            },
          },
        },
      })
    ).status(),
  ).toBe(201);
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto('/');
  await page.getByText('Mobile conversation', { exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Thread', exact: true });
  const reply = dialog.getByRole('textbox', { name: 'Reply', exact: true });
  await reply.fill('A longer mobile reply.\n'.repeat(40));
  expect((await reply.boundingBox())?.height).toBeLessThanOrEqual(128);
  await expect(reply).toHaveCSS('font-size', '16px');
  await page.setViewportSize({ width: 640, height: 320 });
  await dialog.getByRole('button', { name: 'Reply', exact: true }).click();
  await expect(reply).toHaveValue('');
  await page.goto(`${website.origin}/?project=${project.id}`);
  await expect
    .poll(() => page.frames().some((frame) => frame.url().includes('/toolbar?')))
    .toBe(true);
  const frame = page.frames().find((frame) => frame.url().includes('/toolbar?'));
  if (!frame) throw new Error('Toolbar missing');
  await frame.getByRole('button', { name: 'Feedback', exact: false }).click();
  await frame.getByText('Mobile conversation', { exact: true }).click();
  const toolbarReply = frame.getByRole('textbox', { name: 'Reply', exact: true });
  await toolbarReply.fill('Toolbar reply\n'.repeat(30));
  expect((await toolbarReply.boundingBox())?.height).toBeLessThanOrEqual(128);
  await frame.getByRole('button', { name: 'Reply', exact: true }).click();
  await expect(toolbarReply).toHaveValue('');
  await page.setViewportSize({ width: 320, height: 568 });
  await frame.getByRole('button', { name: 'Minimize toolbar', exact: true }).click();
  const clipped = await frame.locator('button').evaluateAll((elements) =>
    elements.flatMap((element) => {
      const bounds = element.getBoundingClientRect();
      return bounds.width && (bounds.left < 0 || bounds.right > innerWidth)
        ? [element.getAttribute('aria-label') ?? element.textContent]
        : [];
    }),
  );
  expect(clipped).toEqual([]);
  await frame.getByRole('button', { name: 'Minimize to icon', exact: true }).click();
  const open = frame.getByRole('button', { name: 'Open feedback', exact: true });
  const geometry = await open.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return { left: bounds.left, right: bounds.right, width: innerWidth, height: bounds.height };
  });
  expect(geometry.left).toBeGreaterThanOrEqual(0);
  expect(geometry.right).toBeLessThanOrEqual(geometry.width);
  expect(geometry.height).toBeGreaterThanOrEqual(44);
  await open.click();
  expect(await frame.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
});
