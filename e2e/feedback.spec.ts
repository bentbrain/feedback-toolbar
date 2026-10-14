import { test, expect, type Locator } from '@playwright/test';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { projectSchema, publicJobSchema, threadSchema } from '../src/shared/models.js';

async function textContrast(element: Locator, backgroundSelector?: string) {
  return element.evaluate((element, selector) => {
    const background = selector ? element.closest(selector) : element;
    if (!background) throw new Error('Contrast background is missing.');
    const luminance = (color: string) => {
      const channels = color
        .match(/[\d.]+/g)
        ?.slice(0, 3)
        .map(Number);
      if (channels?.length !== 3) throw new Error(`Unexpected rendered color: ${color}`);
      return channels.reduce((sum, channel, index) => {
        const value = channel / 255;
        return (
          sum +
          (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4) *
            ([0.2126, 0.7152, 0.0722][index] ?? 0)
        );
      }, 0);
    };
    const foreground = luminance(getComputedStyle(element).color);
    const backdrop = luminance(getComputedStyle(background).backgroundColor);
    return (Math.max(foreground, backdrop) + 0.05) / (Math.min(foreground, backdrop) + 0.05);
  }, backgroundSelector);
}

test('new user creates a project, customizes its theme, and gets the installation snippet', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-mode', 'dark');
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toHaveCSS(
    'background-color',
    'rgb(40, 112, 255)',
  );
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toHaveCSS(
    'color',
    'rgb(0, 0, 0)',
  );
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-mode', 'light');
  expect(
    await page.evaluate(async () => (await document.fonts.load('12px "Geist Mono"')).length),
  ).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Create an account' }).click();
  await page.getByLabel('Name').fill('Alex Morgan');
  await page.getByLabel('Email address').fill(`${randomUUID()}@example.invalid`);
  await page.getByLabel('Password', { exact: true }).fill(randomUUID());
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.getByRole('button', { name: 'Account security', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Account security' })).toBeVisible();
  await expect(page.getByText('No connected tools or websites.')).toBeVisible();
  await page.getByRole('button', { name: 'Feedback', exact: true }).click();
  await page.getByRole('button', { name: 'Create your first project' }).click();
  await page.getByLabel('Project name').fill('Forma website');
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Installation' })).toBeVisible();
  await expect(page.getByText(/data-project="prj_/)).toBeVisible();
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  await page.getByRole('tab', { name: 'dark', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Send to agent', exact: true })).toHaveCSS(
    'background-color',
    'rgb(40, 112, 255)',
  );
  await expect(page.getByRole('button', { name: 'Send to agent', exact: true })).toHaveCSS(
    'color',
    'rgb(0, 0, 0)',
  );
  const primary = page.getByRole('button', { name: 'Send to agent', exact: true });
  const outline = page.getByRole('button', { name: '👍 2', exact: true });
  const secondary = page.locator('[data-slot="avatar-fallback"]').last();
  const previewMessage = page.getByText('Could we give this button a little more space?', {
    exact: true,
  });
  for (const control of [primary, outline, secondary])
    expect(await textContrast(control)).toBeGreaterThanOrEqual(4.5);
  expect(await textContrast(previewMessage, '[data-slot="card"]')).toBeGreaterThanOrEqual(4.5);
  await primary.hover();
  expect(await textContrast(primary)).toBeGreaterThanOrEqual(4.5);
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.getByRole('tab', { name: 'light', exact: true }).click();
  await expect(primary.locator('xpath=ancestor::*[@data-slot="card"][1]')).toHaveCSS(
    'background-color',
    'rgb(255, 255, 255)',
  );
  expect(await textContrast(previewMessage, '[data-slot="card"]')).toBeGreaterThanOrEqual(4.5);
  expect(await textContrast(secondary)).toBeGreaterThanOrEqual(4.5);
  await page.getByRole('tab', { name: 'dark', exact: true }).click();
  await page.emulateMedia({ colorScheme: 'light' });
  await page.getByRole('button', { name: 'Use #72865d', exact: true }).click();
  await page.getByRole('button', { name: 'Save appearance', exact: true }).click();
  await expect(page.getByText('All changes saved')).toBeVisible();
  const state = await page.request.get('/api/projects');
  const result = z.object({ projects: z.array(projectSchema) }).parse(await state.json());
  expect(result.projects[0]?.theme.mode).toBe('dark');
  expect(result.projects[0]?.theme.accent).toBe('#72865d');
  const project = result.projects[0];
  if (!project) throw new Error('Project missing.');
  const createdThread = await page.request.post(`/api/projects/${project.id}/threads`, {
    data: {
      body: 'Preserve iPhone and Japan URL casing',
      context: {
        url: 'http://localhost:44321/',
        viewport: { width: 1280, height: 800 },
        deployment: null,
        anchor: {
          selector: 'button',
          feedbackId: null,
          tag: 'button',
          text: 'Button',
          label: '',
          rect: { x: 0, y: 0, width: 100, height: 30 },
        },
      },
    },
  });
  const thread = z.object({ thread: threadSchema }).parse(await createdThread.json()).thread;
  await page.request.post(`/api/threads/${thread.id}/messages`, { data: { body: 'Use magenta' } });
  await page.getByRole('button', { name: 'Feedback', exact: true }).click();
  await page.getByRole('textbox', { name: 'Search feedback' }).fill('magenta');
  await expect(
    page.getByText('Preserve iPhone and Japan URL casing', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Preserve iPhone and Japan URL casing', { exact: true })).toHaveCSS(
    'text-transform',
    'none',
  );
  await page.getByText('Preserve iPhone and Japan URL casing', { exact: true }).click();
  await expect(page.getByText('Use magenta', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('textbox', { name: 'Search feedback' }).fill('absent-term');
  await expect(page.getByText('Preserve iPhone and Japan URL casing', { exact: true })).toHaveCount(
    0,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('isolated toolbar authenticates independently and completes the feedback-to-agent loop', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && message.text().includes('Content Security Policy'))
      errors.push(message.text());
  });
  const account = await page.request.post('/api/auth/sign-up/email', {
    data: {
      name: 'Taylor Review',
      email: `${randomUUID()}@example.invalid`,
      password: randomUUID(),
    },
  });
  expect(account.status()).toBe(200);
  const created = await page.request.post('/api/projects', {
    data: {
      name: 'Toolbar test',
      origins: ['http://localhost:44321'],
      theme: { mode: 'dark', accent: '#788468', radius: 'square' },
    },
  });
  const project = z.object({ project: projectSchema }).parse(await created.json()).project;
  await page.goto(`http://localhost:44321/?project=${project.id}`);
  await expect
    .poll(() => page.frames().some((frame) => frame.url().includes('/toolbar?')))
    .toBe(true);
  const frame = page.frames().find((frame) => frame.url().includes('/toolbar?'));
  if (!frame) throw new Error('Toolbar frame missing.');
  await frame.getByRole('button', { name: 'Feedback', exact: false }).click();
  await expect(frame.getByRole('button', { name: 'Sign in to Feedback' })).toBeVisible();
  await expect(frame.locator('html')).toHaveAttribute('data-mode', 'dark');
  await expect(frame.locator('html')).toHaveCSS('--primary', '#788468');
  await expect(frame.locator('html')).toHaveCSS('--radius', '0px');
  const popupPromise = page.waitForEvent('popup');
  await frame.getByRole('button', { name: 'Sign in to Feedback' }).click();
  const popup = await popupPromise;
  await popup.waitForURL(/\/auth\?user_code=/);
  await popup.getByRole('button', { name: 'Approve connection' }).click();
  await expect(popup.getByText('Connection approved.')).toBeVisible();
  await popup.close();
  await expect(frame.getByRole('button', { name: 'New feedback' })).toBeVisible({
    timeout: 15_000,
  });
  await page.evaluate(() => {
    const editing = document.createElement('section');
    editing.innerHTML =
      '<div id="editable-empty" contenteditable>Secret draft</div><div id="editable-plain" contenteditable="plaintext-only">Secret plaintext</div><div contenteditable><span id="editable-inherited">Inherited secret</span></div><div id="editable-parent">Public text <div contenteditable>Private child draft</div></div>';
    document.body.prepend(editing);
  });
  for (const id of ['editable-empty', 'editable-plain', 'editable-inherited']) {
    await frame.getByRole('button', { name: 'New feedback' }).click();
    await page.locator(`#${id}`).click();
    await expect(frame.getByText('[Private element]', { exact: true })).toBeVisible();
    await expect(frame.getByText(/Secret draft|Secret plaintext|Inherited secret/)).toHaveCount(0);
    await frame.getByRole('button', { name: 'Back to feedback', exact: true }).click();
  }
  await frame.getByRole('button', { name: 'New feedback' }).click();
  await page.locator('#editable-parent').click({ position: { x: 5, y: 5 } });
  await expect(frame.getByText('Public text', { exact: true })).toBeVisible();
  await expect(frame.getByText('Private child draft', { exact: true })).toHaveCount(0);
  await frame.getByRole('button', { name: 'Back to feedback', exact: true }).click();
  await frame.getByRole('button', { name: 'New feedback' }).click();
  await page.locator('[data-feedback-id=hero-button]').click();
  await frame
    .getByLabel('What would you like to change?')
    .fill('Please increase the spacing around this iPhone button.');
  const postedPromise = page.waitForResponse(
    (response) => response.url().includes('/threads') && response.request().method() === 'POST',
    { timeout: 5000 },
  );
  await frame.getByRole('button', { name: 'Post feedback' }).click();
  const posted = await postedPromise;
  expect(posted.status()).toBe(201);
  await expect(
    frame.getByText('Please increase the spacing around this iPhone button.'),
  ).toBeVisible();
  await expect(frame.getByText('Please increase the spacing around this iPhone button.')).toHaveCSS(
    'text-transform',
    'none',
  );
  await frame.getByRole('button', { name: 'Back to feedback', exact: true }).click();
  await expect(frame.getByText('Please increase the spacing around this iPhone button.')).toHaveCSS(
    'text-transform',
    'none',
  );
  await frame.getByText('Please increase the spacing around this iPhone button.').click();
  await frame.getByRole('button', { name: 'React with 👍' }).click();
  await frame.getByRole('button', { name: 'Send to agent' }).click();
  await expect(frame.getByText('Queued. Waiting for the agent.')).toBeVisible();
  const data = z
    .object({ threads: z.array(threadSchema) })
    .parse(await (await page.request.get(`/api/projects/${project.id}/threads`)).json());
  expect(data.threads[0]?.context.anchor.feedbackId).toBe('hero-button');
  const preview = data.threads[0];
  if (!preview) throw new Error('Expected the created thread preview.');
  const detail = z
    .object({ thread: threadSchema })
    .parse(await (await page.request.get(`/api/threads/${preview.id}`)).json());
  expect(detail.thread.messages[0]?.reactions.length).toBe(1);
  const auth = z.object({ token: z.string() }).parse(
    await (
      await page.request.post(`/api/projects/${project.id}/credentials`, {
        data: { name: 'Review agent' },
      })
    ).json(),
  );
  const claim = z.object({ job: publicJobSchema, lease: z.string() }).parse(
    await (
      await page.request.post(`/api/projects/${project.id}/work/claim`, {
        headers: { Authorization: `Bearer ${auth.token}` },
        data: {},
      })
    ).json(),
  );
  const complete = await page.request.post(`/api/work/${claim.job.id}/complete`, {
    headers: { Authorization: `Bearer ${auth.token}` },
    data: {
      lease: claim.lease,
      status: 'review',
      body: 'Proposed spacing change is ready. Please review the diff.',
    },
  });
  expect(complete.status()).toBe(200);
  await expect(
    frame.getByText('Proposed spacing change is ready. Please review the diff.'),
  ).toBeVisible({ timeout: 10_000 });
  await frame.evaluate(async () => {
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: 'https://unregistered.example',
        source: window.parent,
        data: { type: 'feedback:navigation', url: 'https://unregistered.example' },
      }),
    );
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: 'http://localhost:44321',
        source: window,
        data: { type: 'feedback:navigation', url: 'http://localhost:44321/forged' },
      }),
    );
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          resolve();
        }),
      );
    });
  });
  await expect(
    frame.getByText('Proposed spacing change is ready. Please review the diff.'),
  ).toBeVisible();
  await page.addStyleTag({
    content:
      '* { font-size:48px !important; color:red !important; border-radius:0 !important } iframe { opacity:0 !important }',
  });
  const font = await frame
    .getByText('Proposed spacing change is ready. Please review the diff.')
    .evaluate((element) => getComputedStyle(element).fontSize);
  expect(font).toBe('12px');
  const inaccessible = await page.evaluate(
    () => document.querySelector('[data-feedback-host]')?.shadowRoot === null,
  );
  expect(inaccessible).toBe(true);
  await frame.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(frame.getByRole('button', { name: 'Sign in to Feedback' })).toBeVisible();
  await frame.evaluate((projectId) => {
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: 'http://localhost:44321',
        source: window.parent,
        data: {
          type: 'feedback:configure',
          projectId,
          theme: { accent: '#4065ab' },
          url: 'http://localhost:44321/',
          viewport: { width: innerWidth, height: innerHeight },
        },
      }),
    );
  }, project.id);
  await expect(frame.locator('html')).toHaveCSS('--primary', '#4065ab');
  await expect(frame.locator('html')).toHaveAttribute('data-mode', 'dark');
  await expect(frame.locator('html')).toHaveCSS('--radius', '0px');
  expect(errors).toEqual([]);
});

test('embedded toolbar reconciles older pages and retains an active resolved conversation', async ({
  page,
}) => {
  expect(
    (
      await page.request.post('/api/auth/sign-up/email', {
        data: {
          name: 'Embedded pagination reviewer',
          email: `${randomUUID()}@example.invalid`,
          password: randomUUID(),
        },
      })
    ).status(),
  ).toBe(200);
  const project = z.object({ project: projectSchema }).parse(
    await (
      await page.request.post('/api/projects', {
        data: { name: 'Embedded cached pages', origins: ['http://localhost:44321'] },
      })
    ).json(),
  ).project;
  const context = {
    url: 'http://localhost:44321/',
    viewport: { width: 1280, height: 800 },
    deployment: null,
    anchor: {
      selector: 'button',
      feedbackId: null,
      tag: 'button',
      text: 'Button',
      label: '',
      rect: { x: 0, y: 0, width: 100, height: 30 },
    },
  };
  const ids: string[] = [];
  for (let index = 0; index < 53; index++) {
    const response = await page.request.post(`/api/projects/${project.id}/threads`, {
      data: { context, body: `Embedded older feedback ${index}` },
    });
    expect(response.status()).toBe(201);
    ids.push(z.object({ thread: threadSchema }).parse(await response.json()).thread.id);
  }
  await page.goto(`http://localhost:44321/?project=${project.id}`);
  await expect
    .poll(() => page.frames().some((frame) => frame.url().includes('/toolbar?')))
    .toBe(true);
  const frame = page.frames().find((frame) => frame.url().includes('/toolbar?'));
  if (!frame) throw new Error('Toolbar frame missing.');
  await frame.getByRole('button', { name: 'Feedback', exact: false }).click();
  const popupPromise = page.waitForEvent('popup');
  await frame.getByRole('button', { name: 'Sign in to Feedback' }).click();
  const popup = await popupPromise;
  await popup.waitForURL(/\/auth\?user_code=/);
  await popup.getByRole('button', { name: 'Approve connection' }).click();
  await expect(popup.getByText('Connection approved.')).toBeVisible();
  await popup.close();
  await expect(frame.getByRole('button', { name: 'Load earlier feedback' })).toBeVisible({
    timeout: 15_000,
  });
  await expect(frame.getByText('Embedded older feedback 0', { exact: true })).toHaveCount(0);
  await frame.getByRole('button', { name: 'Load earlier feedback' }).click();
  await expect(frame.getByText('Embedded older feedback 0', { exact: true })).toBeVisible();
  const oldest = ids[0];
  if (!oldest) throw new Error('Oldest thread missing.');
  await page.request.patch(`/api/threads/${oldest}`, { data: { status: 'resolved' } });
  await expect(frame.getByText('Embedded older feedback 0', { exact: true })).toHaveCount(0, {
    timeout: 10_000,
  });
  await expect(frame.getByText('Embedded older feedback 1', { exact: true })).toBeVisible();
  await frame.getByText('Embedded older feedback 1', { exact: true }).click();
  await frame.getByRole('button', { name: 'Resolve', exact: true }).click();
  await expect(frame.getByRole('button', { name: 'Reopen', exact: true })).toBeVisible();
  await frame.getByRole('button', { name: 'Back to feedback', exact: true }).click();
  await expect(frame.getByText('Embedded older feedback 1', { exact: true })).toHaveCount(0);
  await expect(frame.getByText('Embedded older feedback 2', { exact: true })).toBeVisible();
});

test('filtered dashboard reconciles resolved cached rows while preserving loaded earlier conversations', async ({
  page,
}) => {
  const signup = await page.request.post('/api/auth/sign-up/email', {
    data: {
      name: 'Pagination reviewer',
      email: `${randomUUID()}@example.invalid`,
      password: randomUUID(),
    },
  });
  expect(signup.status()).toBe(200);
  const project = z.object({ project: projectSchema }).parse(
    await (
      await page.request.post('/api/projects', {
        data: { name: 'Cached pages', origins: ['http://localhost:44321'] },
      })
    ).json(),
  ).project;
  const context = {
    url: 'http://localhost:44321/',
    viewport: { width: 1280, height: 800 },
    deployment: null,
    anchor: {
      selector: 'button',
      feedbackId: null,
      tag: 'button',
      text: 'Button',
      label: '',
      rect: { x: 0, y: 0, width: 100, height: 30 },
    },
  };
  const ids: string[] = [];
  for (let index = 0; index < 53; index++) {
    const result = await page.request.post(`/api/projects/${project.id}/threads`, {
      data: { context, body: `Cached feedback ${index}` },
    });
    expect(result.status()).toBe(201);
    ids.push(z.object({ thread: threadSchema }).parse(await result.json()).thread.id);
  }
  await page.goto('/');
  await page.getByRole('tab', { name: 'Open', exact: true }).click();
  await expect(page.getByText('Cached feedback 0', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Load earlier conversations' }).click();
  await page.getByText('Cached feedback 0', { exact: true }).click();
  await page.getByRole('button', { name: 'Resolve', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Reopen', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByText('Cached feedback 0', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Cached feedback 1', { exact: true })).toBeVisible();
  // A change outside this dialog must also remove a cached match on the next refresh.
  const olderId = ids[1];
  if (!olderId) throw new Error('Earlier thread missing.');
  await page.request.patch(`/api/threads/${olderId}`, { data: { status: 'resolved' } });
  await expect(page.getByText('Cached feedback 1', { exact: true })).toHaveCount(0, {
    timeout: 15_000,
  });
  await expect(page.getByText('Cached feedback 2', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Resolved', exact: true }).click();
  await expect(page.getByText('Cached feedback 0', { exact: true })).toBeVisible();
  await expect(page.getByText('Cached feedback 1', { exact: true })).toBeVisible();
  await page.getByText('Cached feedback 0', { exact: true }).click();
  await page.getByRole('button', { name: 'Reopen', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Resolve', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByText('Cached feedback 0', { exact: true })).toHaveCount(0);
});
