import type { Frame, Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { projectSchema } from '../src/shared/models.js';
import { test, expect } from './fixtures.js';

async function toolbar(page: Page): Promise<Frame> {
  const signup = await page.request.post('/api/auth/sign-up/email', {
    data: {
      name: 'Performance review',
      email: `${randomUUID()}@example.invalid`,
      password: randomUUID(),
    },
  });
  expect(signup.status()).toBe(200);
  const created = await page.request.post('/api/projects', {
    data: { name: 'Performance fixture', origins: ['http://localhost:44321'] },
  });
  const { project } = z.object({ project: projectSchema }).parse(await created.json());
  await page.goto(`http://localhost:44321/?project=${project.id}`);
  await expect
    .poll(() => page.frames().some((frame) => frame.url().includes('/toolbar?')))
    .toBe(true);
  const frame = page.frames().find((frame) => frame.url().includes('/toolbar?'));
  if (!frame) throw new Error('Toolbar frame missing');
  await frame.getByRole('button', { name: 'Feedback', exact: false }).click();
  await expect(frame.getByRole('button', { name: 'New feedback' })).toBeVisible();
  return frame;
}

async function compose(page: Page, frame: Frame) {
  await frame.getByRole('button', { name: 'New feedback' }).click();
  await page.locator('[data-feedback-id=hero-button]').click();
  await frame
    .getByLabel('What would you like to change?')
    .fill('Keep acknowledged feedback visible');
}

function gate() {
  let release: () => void = () => {
    throw new Error('Gate is not initialized');
  };
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    promise,
    release: () => {
      release();
    },
  };
}

test('acknowledged feedback stays visible while follow-up reads are delayed', async ({ page }) => {
  const frame = await toolbar(page);
  await compose(page, frame);
  const reads = gate();
  await page.route('**/api/**', async (route) => {
    if (route.request().method() === 'GET' && /\/threads(?:\?|\/|$)/.test(route.request().url()))
      await reads.promise;
    await route.continue();
  });
  try {
    const posted = page.waitForResponse(
      (response) => response.request().method() === 'POST' && response.url().endsWith('/threads'),
    );
    await frame.getByRole('button', { name: 'Post feedback' }).click();
    expect((await posted).status()).toBe(201);
    await expect(
      frame.getByText('Keep acknowledged feedback visible', { exact: true }),
    ).toBeVisible({ timeout: 1500 });
    await frame.getByRole('button', { name: 'Back to feedback', exact: true }).click();
    await expect(
      frame.getByText('Keep acknowledged feedback visible', { exact: true }),
    ).toBeVisible({ timeout: 1500 });
  } finally {
    reads.release();
  }
});

test('queue request signals pending immediately and confirms only after acknowledgement', async ({
  page,
}) => {
  const frame = await toolbar(page);
  await compose(page, frame);
  await frame.getByRole('button', { name: 'Post feedback' }).click();
  await expect(
    frame.getByText('Keep acknowledged feedback visible', { exact: true }),
  ).toBeVisible();
  const queue = gate();
  let requests = 0;
  await page.route('**/api/threads/*/work', async (route) => {
    if (route.request().method() === 'POST') {
      requests++;
      await queue.promise;
    }
    await route.continue();
  });
  try {
    await frame.getByRole('button', { name: 'Send to agent', exact: true }).click();
    const pending = frame.getByRole('button', { name: 'Sending to agent…', exact: true });
    await expect(pending).toBeDisabled({ timeout: 1000 });
    await expect(frame.getByText('Queued. Waiting for the agent.', { exact: true })).toHaveCount(0);
    expect(requests).toBe(1);
    queue.release();
    await expect(frame.getByText('Queued. Waiting for the agent.', { exact: true })).toBeVisible();
    expect(requests).toBe(1);
  } finally {
    queue.release();
  }
});

test('posting is pending until acknowledged and retains the draft on rejection', async ({
  page,
}) => {
  const frame = await toolbar(page);
  await compose(page, frame);
  const post = gate();
  await page.route('**/api/projects/*/threads', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    await post.promise;
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Try again later.' }),
    });
  });
  try {
    await frame.getByRole('button', { name: 'Post feedback', exact: true }).click();
    await expect(frame.getByRole('button', { name: 'Posting…', exact: true })).toBeDisabled({
      timeout: 1000,
    });
    await expect(frame.getByLabel('What would you like to change?')).toHaveValue(
      'Keep acknowledged feedback visible',
    );
    post.release();
    await expect(frame.getByRole('alert')).toHaveText('Try again later.');
    await expect(frame.getByRole('button', { name: 'Post feedback', exact: true })).toBeEnabled();
    await page.unroute('**/api/projects/*/threads');
    await frame.getByRole('button', { name: 'Post feedback', exact: true }).click();
    await expect(
      frame.getByText('Keep acknowledged feedback visible', { exact: true }),
    ).toBeVisible();
    await expect(frame.getByRole('alert')).toHaveCount(0);
  } finally {
    post.release();
  }
});

for (const status of ['queued', 'cancelled']) {
  test(`lost queue acknowledgement recovers ${status} work without duplicating it`, async ({
    page,
  }) => {
    const frame = await toolbar(page);
    await compose(page, frame);
    await frame.getByRole('button', { name: 'Post feedback' }).click();
    await expect(
      frame.getByText('Keep acknowledged feedback visible', { exact: true }),
    ).toBeVisible();
    const reads = gate();
    await page.route('**/api/**', async (route) => {
      if (route.request().method() === 'GET' && route.request().url().includes('/threads'))
        await reads.promise;
      await route.continue();
    });
    const keys: string[] = [];
    let threadUrl = '';
    let jobId = '';
    await page.route('**/api/threads/*/work', async (route) => {
      const body: unknown = route.request().postDataJSON();
      keys.push(z.object({ idempotencyKey: z.string() }).parse(body).idempotencyKey);
      threadUrl = route
        .request()
        .url()
        .replace(/\/work$/, '');
      if (keys.length === 1) {
        const response = await route.fetch();
        expect(response.status()).toBe(201);
        jobId = z.object({ job: z.object({ id: z.string() }) }).parse(await response.json()).job.id;
        await route.abort('failed');
      } else await route.continue();
    });
    try {
      const send = frame.getByRole('button', { name: 'Send to agent', exact: true });
      await send.click();
      await expect(frame.locator('[data-sonner-toast][data-type="error"]')).toBeVisible();
      await expect(frame.locator('[data-sonner-toast][data-type="success"]')).toHaveCount(0);
      await expect(send).toBeEnabled();
      if (status === 'cancelled') {
        const cancelled = await page.request.post(`/api/work/${jobId}/cancel`, { data: {} });
        expect(cancelled.status()).toBe(200);
      }
      await send.click();
      await expect(
        frame
          .getByText(status === 'queued' ? 'Queued. Waiting for the agent.' : 'Work cancelled.', {
            exact: true,
          })
          .first(),
      ).toBeVisible();
      if (status === 'cancelled')
        await expect(frame.locator('[data-sonner-toast][data-type="success"]')).toHaveCount(0);
      expect(keys).toHaveLength(2);
      expect(keys[0]).toBe(keys[1]);
      const detail = await page.request.get(threadUrl);
      expect(
        z.object({ jobs: z.array(z.object({ id: z.string() })) }).parse(await detail.json()).jobs,
      ).toHaveLength(1);
    } finally {
      reads.release();
    }
  });
}

for (const surface of ['toolbar', 'dashboard']) {
  test(`${surface} renders acknowledged replies without waiting for list refresh`, async ({
    page,
  }) => {
    const frame = await toolbar(page);
    await compose(page, frame);
    await frame.getByRole('button', { name: 'Post feedback' }).click();
    await expect(
      frame.getByText('Keep acknowledged feedback visible', { exact: true }),
    ).toBeVisible();
    const ui = surface === 'toolbar' ? frame : page;
    if (surface === 'dashboard') {
      await page.goto('/');
      await page.getByText('Keep acknowledged feedback visible', { exact: true }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
    }
    const reads = gate();
    await page.route('**/api/**', async (route) => {
      if (route.request().method() === 'GET' && route.request().url().includes('/threads'))
        await reads.promise;
      await route.continue();
    });
    try {
      await ui.getByRole('textbox', { name: 'Reply', exact: true }).fill('Acknowledged reply');
      await ui.getByRole('button', { name: 'Reply', exact: true }).click();
      await expect(ui.getByText('Acknowledged reply', { exact: true })).toBeVisible({
        timeout: 1500,
      });
      await expect(ui.getByRole('textbox', { name: 'Reply', exact: true })).toHaveValue('');
      await expect(ui.getByRole('button', { name: 'Send to agent', exact: true })).toBeEnabled();
      await ui.getByRole('button', { name: 'Send to agent', exact: true }).click();
      const notification = ui.locator('[data-sonner-toast][data-type="success"]');
      await expect(notification).toBeVisible({ timeout: 1500 });
      for (const mode of ['light', 'dark']) {
        await page.emulateMedia({ colorScheme: mode === 'light' ? 'light' : 'dark' });
        await expect(notification).toHaveCSS('border-radius', '0px');
        await expect(notification).toHaveCSS(
          'background-color',
          mode === 'light' ? 'rgb(255, 255, 255)' : 'rgb(0, 0, 0)',
        );
        const accent = mode === 'light' ? 'rgb(6, 71, 255)' : 'rgb(40, 112, 255)';
        await expect(notification).toHaveCSS('color', accent);
        await expect(notification).toHaveCSS('border-color', accent);
        await expect(notification.locator('[data-icon]')).toHaveCSS('color', accent);
        await expect(notification).toHaveCSS('font-family', /Geist Mono/);
      }
    } finally {
      reads.release();
    }
  });
}

test('a stale detail response cannot overwrite an acknowledged reply', async ({ page }) => {
  const frame = await toolbar(page);
  await compose(page, frame);
  await frame.getByRole('button', { name: 'Post feedback' }).click();
  await expect(
    frame.getByText('Keep acknowledged feedback visible', { exact: true }),
  ).toBeVisible();
  await frame.getByRole('button', { name: 'Back to feedback', exact: true }).click();
  const staleRead = gate();
  const captured = gate();
  let delayed = false;
  await page.route('**/api/threads/*', async (route) => {
    if (route.request().method() !== 'GET' || delayed) return route.continue();
    delayed = true;
    const response = await route.fetch();
    captured.release();
    await staleRead.promise;
    await route.fulfill({ response });
  });
  try {
    await frame.getByText('Keep acknowledged feedback visible', { exact: true }).click();
    await captured.promise;
    await frame
      .getByRole('textbox', { name: 'Reply', exact: true })
      .fill('Newer than the delayed detail');
    await frame.getByRole('button', { name: 'Reply', exact: true }).click();
    await expect(frame.getByText('Newer than the delayed detail', { exact: true })).toBeVisible();
    const delivered = page.waitForResponse(
      (response) =>
        response.request().method() === 'GET' && /\/api\/threads\/[^/]+$/.test(response.url()),
    );
    staleRead.release();
    await delivered;
    // Give the browser two render frames to apply a stale response if it is not fenced.
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
    await expect(frame.getByText('Newer than the delayed detail', { exact: true })).toBeVisible();
  } finally {
    staleRead.release();
  }
});

test('a delayed acknowledgement stays scoped to its dashboard project', async ({ page }) => {
  const frame = await toolbar(page);
  await compose(page, frame);
  await frame.getByRole('button', { name: 'Post feedback' }).click();
  await expect(
    frame.getByText('Keep acknowledged feedback visible', { exact: true }),
  ).toBeVisible();
  await page.goto('/');
  await expect(
    page
      .getByRole('combobox', { name: 'Project', exact: true })
      .locator('[data-slot="select-value"]'),
  ).toHaveText('Performance fixture');
  const created = await page.request.post('/api/projects', {
    data: { name: 'Other project', origins: ['http://localhost:44321'] },
  });
  expect(created.status()).toBe(201);
  await page.reload();
  await page.getByText('Keep acknowledged feedback visible', { exact: true }).click();
  const acknowledged = gate();
  const captured = gate();
  await page.route('**/api/threads/*/messages', async (route) => {
    const response = await route.fetch();
    captured.release();
    await acknowledged.promise;
    await route.fulfill({ response });
  });
  try {
    await page
      .getByRole('textbox', { name: 'Reply', exact: true })
      .fill('Belongs to the first project');
    await page.getByRole('button', { name: 'Reply', exact: true }).click();
    await captured.promise;
    await page.keyboard.press('Escape');
    await page.getByRole('combobox', { name: 'Project', exact: true }).click();
    await page.getByRole('option', { name: 'Other project', exact: true }).click();
    await expect(page.getByText('Keep acknowledged feedback visible', { exact: true })).toHaveCount(
      0,
    );
    const delivered = page.waitForResponse(
      (response) => response.request().method() === 'POST' && response.url().endsWith('/messages'),
    );
    acknowledged.release();
    await delivered;
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
    await expect(page.getByText('Keep acknowledged feedback visible', { exact: true })).toHaveCount(
      0,
    );
    await expect(
      page
        .getByRole('combobox', { name: 'Project', exact: true })
        .locator('[data-slot="select-value"]'),
    ).toHaveText('Other project');
  } finally {
    acknowledged.release();
  }
});

test('newer refresh state survives delayed thread and queue acknowledgements', async ({ page }) => {
  const frame = await toolbar(page);
  await compose(page, frame);
  await frame.getByRole('button', { name: 'Post feedback' }).click();
  await expect(
    frame.getByText('Keep acknowledged feedback visible', { exact: true }),
  ).toBeVisible();
  const reply = gate();
  const replySaved = gate();
  let threadUrl = '';
  await page.route('**/api/threads/*/messages', async (route) => {
    threadUrl = route
      .request()
      .url()
      .replace(/\/messages$/, '');
    const response = await route.fetch();
    replySaved.release();
    await reply.promise;
    await route.fulfill({ response });
  });
  try {
    await frame
      .getByRole('textbox', { name: 'Reply', exact: true })
      .fill('Delayed acknowledgement');
    await frame.getByRole('button', { name: 'Reply', exact: true }).click();
    await replySaved.promise;
    const newer = await page.request.post(`${threadUrl}/messages`, {
      data: { body: 'Newer server revision' },
    });
    expect(newer.status()).toBe(201);
    await frame.getByRole('button', { name: 'Back to feedback', exact: true }).click();
    await frame.getByText('Keep acknowledged feedback visible', { exact: true }).click();
    await expect(frame.getByText('Newer server revision', { exact: true })).toBeVisible();
    const delivered = page.waitForResponse(
      (response) => response.request().method() === 'POST' && response.url().endsWith('/messages'),
    );
    reply.release();
    await delivered;
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
    await expect(frame.getByText('Newer server revision', { exact: true })).toBeVisible();
  } finally {
    reply.release();
  }
  const queue = gate();
  const queueSaved = gate();
  let jobId = '';
  await page.route('**/api/threads/*/work', async (route) => {
    const response = await route.fetch();
    jobId = z.object({ job: z.object({ id: z.string() }) }).parse(await response.json()).job.id;
    queueSaved.release();
    await queue.promise;
    await route.fulfill({ response });
  });
  try {
    await frame.getByRole('button', { name: 'Send to agent', exact: true }).click();
    await queueSaved.promise;
    const cancelled = await page.request.post(`/api/work/${jobId}/cancel`, { data: {} });
    expect(cancelled.status()).toBe(200);
    await frame.getByRole('button', { name: 'Back to feedback', exact: true }).click();
    await frame.getByText('Keep acknowledged feedback visible', { exact: true }).click();
    await expect(frame.getByText('Work cancelled.', { exact: true })).toBeVisible();
    const delivered = page.waitForResponse(
      (response) => response.request().method() === 'POST' && response.url().endsWith('/work'),
    );
    queue.release();
    await delivered;
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
    await expect(frame.getByText('Work cancelled.', { exact: true }).first()).toBeVisible();
    await expect(frame.getByRole('button', { name: 'Send to agent', exact: true })).toBeEnabled();
    await expect(frame.locator('[data-sonner-toast][data-type="success"]')).toHaveCount(0);
  } finally {
    queue.release();
  }
});
