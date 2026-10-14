import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { test, expect } from './fixtures.js';
import { projectSchema, threadSchema } from '../src/shared/models.js';

test.beforeEach(async ({ page }) => {
  await page.request.post('/api/auth/sign-up/email', {
    data: { name: 'Alex', email: `${randomUUID()}@example.invalid`, password: randomUUID() },
  });
  const response = await page.request.post('/api/projects', {
    data: { name: 'Navigation test', origins: ['http://localhost:44321'] },
  });
  const { project } = z.object({ project: projectSchema }).parse(await response.json());
  for (const status of ['open', 'resolved']) {
    const response = await page.request.post(`/api/projects/${project.id}/threads`, {
      data: {
        body: `${status} conversation`,
        context: {
          url: 'http://localhost:44321/',
          viewport: { width: 1280, height: 800 },
          deployment: null,
          anchor: {
            selector: 'button',
            feedbackId: null,
            tag: 'button',
            text: 'Submit',
            label: '',
            rect: { x: 0, y: 0, width: 100, height: 30 },
          },
        },
      },
    });
    const { thread } = z.object({ thread: threadSchema }).parse(await response.json());
    if (status === 'resolved') {
      await page.request.patch(`/api/threads/${thread.id}`, { data: { status } });
    }
  }
  await page.goto('/');
  await expect(page.getByText('open conversation', { exact: true })).toBeVisible();
});

test('framework inline scripts use the response CSP nonce', async ({ page }) => {
  const response = await page.reload();
  const policy = response?.headers()['content-security-policy'];
  const nonce = await page.locator('meta[name="csp-nonce"]').getAttribute('content');
  expect(nonce).toBeTruthy();
  expect(nonce).not.toBe('__FEEDBACK_NONCE__');
  expect(policy).toContain(`'nonce-${nonce}'`);
  const scripts = await page.evaluate(() =>
    [...document.scripts].filter((script) => !script.src).map((script) => script.nonce),
  );
  expect(scripts.length).toBeGreaterThan(0);
  expect(scripts.every((value) => value === nonce)).toBe(true);
  await expect(page.getByText('open conversation', { exact: true })).toBeVisible();
});

test('sidebar navigation supports URLs, reloads, and browser back and forward', async ({
  page,
}) => {
  const navigation = page.getByRole('navigation', { name: 'Project navigation' });
  await navigation.getByText('Installation', { exact: true }).click();
  await expect(page).toHaveURL(/\/install$/);
  await navigation.getByText('Appearance', { exact: true }).click();
  await expect(page).toHaveURL(/\/appearance$/);
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Installation', exact: true })).toBeVisible();
  await page.goForward();
  await expect(page.getByRole('heading', { name: 'Appearance', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Appearance', exact: true })).toBeVisible();
  await expect(navigation.getByRole('link', { name: 'Appearance', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
});

test('feedback keeps previous results during a slow filter fetch and reuses cached tabs', async ({
  page,
}) => {
  let release = () => {
    /* Assigned synchronously by the promise below. */
  };
  let started = () => {
    /* Assigned synchronously by the promise below. */
  };
  const pending = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/projects/*/threads?**', async (route) => {
    if (new URL(route.request().url()).searchParams.get('status') === 'open') {
      started();
      await gate;
    }
    await route.continue();
  });
  try {
    await page.getByRole('tab', { name: 'Open', exact: true }).click();
    await pending;
    await expect(page.getByText('open conversation', { exact: true })).toBeVisible({
      timeout: 1000,
    });
    await expect(page.getByRole('heading', { name: 'No feedback', exact: true })).toBeHidden();
  } finally {
    release();
  }
  await expect(page.getByText('resolved conversation', { exact: true })).toBeHidden();
  await page.getByRole('tab', { name: 'Resolved', exact: true }).click();
  await expect(page.getByText('resolved conversation', { exact: true })).toBeVisible();
  await expect(page.getByText('open conversation', { exact: true })).toBeHidden();
  await page.route('**/api/projects/*/threads?**', (route) => route.abort());
  await page.getByRole('tab', { name: 'Open', exact: true }).click();
  await expect(page.getByText('open conversation', { exact: true })).toBeVisible({ timeout: 1000 });
  await expect(page.getByText('resolved conversation', { exact: true })).toBeHidden();
});
