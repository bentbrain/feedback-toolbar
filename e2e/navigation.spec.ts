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

test('thread detail keeps the newest work when an older run is absent from the list', async ({
  page,
}) => {
  await page.route('**/api/projects/*/threads?**', async (route) => {
    const response = await route.fetch();
    const data = z.looseObject({ threads: z.array(threadSchema) }).parse(await response.json());
    const thread = data.threads.find((item) => item.messages[0]?.body === 'open conversation');
    if (!thread) throw new Error('Missing open thread.');
    const job = {
      id: 'new-run',
      projectId: thread.projectId,
      threadId: thread.id,
      requestedBy: 'owner',
      revision: thread.revision,
      status: 'running',
      createdAt: '2026-10-15T02:00:00.000Z',
      updatedAt: '2026-10-15T02:00:00.000Z',
      claimedBy: 'Agent',
      leaseExpiresAt: null,
      runId: null,
      result: null,
    };
    await route.fulfill({ response, json: { ...data, jobs: [job] } });
  });
  await page.route('**/api/threads/*', async (route) => {
    const response = await route.fetch();
    const data = z.object({ thread: threadSchema }).parse(await response.json());
    const job = {
      projectId: data.thread.projectId,
      threadId: data.thread.id,
      requestedBy: 'owner',
      revision: data.thread.revision,
      claimedBy: 'Agent',
      leaseExpiresAt: null,
      runId: null,
      result: null,
    };
    await route.fulfill({
      response,
      json: {
        ...data,
        jobs: [
          {
            ...job,
            id: 'old-run',
            status: 'review',
            createdAt: '2026-10-15T01:00:00.000Z',
            updatedAt: '2026-10-15T01:00:00.000Z',
          },
          {
            ...job,
            id: 'new-run',
            status: 'running',
            createdAt: '2026-10-15T02:00:00.000Z',
            updatedAt: '2026-10-15T02:00:00.000Z',
          },
        ],
      },
    });
  });
  await page.reload();
  await page.getByText('open conversation', { exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: 'Cancel work', exact: true })).toBeVisible();
  await expect(
    dialog.getByRole('button', { name: 'Send remaining feedback', exact: true }),
  ).toBeDisabled();
  await expect(dialog.getByText('Ready for review', { exact: true })).toBeHidden();
});

test('a newer list summary cannot replace full detail after a delayed reply', async ({ page }) => {
  const loaded = page.waitForResponse((response) => /\/api\/threads\/[^/]+$/.test(response.url()));
  await page.getByText('open conversation', { exact: true }).click();
  const dialog = page.getByRole('dialog');
  const detailResponse = await loaded;
  const { thread } = z.object({ thread: threadSchema }).parse(await detailResponse.json());
  await page.request.post(`/api/threads/${thread.id}/messages`, {
    data: { body: 'Existing reply' },
  });
  await page.reload();
  await page.getByText('open conversation', { exact: true }).click();
  await expect(dialog.getByText('Existing reply', { exact: true })).toBeVisible();
  let saved = () => {
    /* Assigned synchronously below. */
  };
  let releaseReply = () => {
    /* Assigned synchronously below. */
  };
  let releaseDetail = () => {
    /* Assigned synchronously below. */
  };
  const savedReply = new Promise<void>((resolve) => {
    saved = resolve;
  });
  const replyGate = new Promise<void>((resolve) => {
    releaseReply = resolve;
  });
  const detailGate = new Promise<void>((resolve) => {
    releaseDetail = resolve;
  });
  await page.route(`**/api/threads/${thread.id}/messages`, async (route) => {
    const response = await route.fetch();
    saved();
    await replyGate;
    await route.fulfill({ response });
  });
  try {
    await dialog.getByRole('textbox', { name: 'Reply', exact: true }).fill('Delayed reply');
    await dialog.getByRole('button', { name: 'Reply', exact: true }).click();
    await savedReply;
    await page.request.post(`/api/threads/${thread.id}/messages`, {
      data: { body: 'Newest reply' },
    });
    await page.route(`**/api/threads/${thread.id}`, async (route) => {
      await detailGate;
      await route.continue();
    });
    const list = page.waitForResponse((response) => response.url().includes('/threads?'));
    await list;
    releaseReply();
    await expect(dialog.getByRole('textbox', { name: 'Reply', exact: true })).toHaveValue('');
    await expect(dialog.getByText('Existing reply', { exact: true })).toBeVisible();
    await expect(dialog.getByText('Delayed reply', { exact: true })).toBeVisible();
    releaseDetail();
    await expect(dialog.getByText('Newest reply', { exact: true })).toBeVisible();
  } finally {
    releaseReply();
    releaseDetail();
  }
});
