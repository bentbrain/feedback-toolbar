import type { Locator, Page } from '@playwright/test';
import { test, expect } from './fixtures.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { projectSchema, publicJobSchema, threadSchema } from '../src/shared/models.js';

async function signupFixture(page: Page, data: { name: string; email: string; password: string }) {
  const response = await page.request.post('/api/auth/sign-up/email', { data });
  expect(response.status()).toBe(200);
}

async function textContrast(element: Locator) {
  return element.evaluate((element) => {
    interface Color {
      red: number;
      green: number;
      blue: number;
      alpha: number;
    }
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Contrast color resolver is unavailable.');
    const resolveColor = (color: string): Color => {
      if (!CSS.supports('color', color)) throw new Error(`Unexpected rendered color: ${color}`);
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data;
      if (red === undefined || green === undefined || blue === undefined || alpha === undefined)
        throw new Error(`Could not resolve rendered color: ${color}`);
      return { red: red / 255, green: green / 255, blue: blue / 255, alpha: alpha / 255 };
    };
    const composite = (foreground: Color, background: Color): Color => ({
      red: foreground.red * foreground.alpha + background.red * (1 - foreground.alpha),
      green: foreground.green * foreground.alpha + background.green * (1 - foreground.alpha),
      blue: foreground.blue * foreground.alpha + background.blue * (1 - foreground.alpha),
      alpha: 1,
    });
    const ancestors: Element[] = [];
    for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement)
      ancestors.unshift(ancestor);
    let background: Color = { red: 1, green: 1, blue: 1, alpha: 1 };
    for (const ancestor of ancestors)
      background = composite(resolveColor(getComputedStyle(ancestor).backgroundColor), background);
    const linearize = (channel: number) =>
      channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    const luminance = (color: Color) =>
      linearize(color.red) * 0.2126 +
      linearize(color.green) * 0.7152 +
      linearize(color.blue) * 0.0722;
    const foreground = luminance(
      composite(resolveColor(getComputedStyle(element).color), background),
    );
    const backdrop = luminance(background);
    return (Math.max(foreground, backdrop) + 0.05) / (Math.min(foreground, backdrop) + 0.05);
  });
}

test('new user creates a project, customizes its theme, and gets the installation snippet', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-mode', 'dark');
  await page.evaluate(() => {
    const fixture = document.createElement('div');
    fixture.id = 'contrast-composition';
    fixture.style.cssText = 'position:fixed;left:0;top:0;background:#000;pointer-events:none';
    fixture.innerHTML =
      '<div style="background:rgba(255,255,255,0.5)"><div style="background:transparent"><span data-contrast="alpha" style="background:color-mix(in srgb, #000 50%, transparent);color:rgba(255,255,255,0.5)">Alpha composition</span></div></div><div style="background:color-mix(in srgb, #2870ff 30%, transparent)"><span data-contrast="tint" style="background:transparent;color:#2870ff">Cobalt tint</span></div>';
    document.body.append(fixture);
  });
  // Known layered colors catch omitted ancestor backgrounds and foreground alpha.
  expect(await textContrast(page.locator('[data-contrast="alpha"]'))).toBeCloseTo(3.95, 1);
  const tintedContrast = await textContrast(page.locator('[data-contrast="tint"]'));
  expect(tintedContrast).toBeCloseTo(3.61, 1);
  expect(tintedContrast).toBeLessThan(4.5);
  await page.locator('#contrast-composition').evaluate((fixture) => {
    fixture.remove();
  });
  const email = page.getByLabel('Email address');
  const enteredEmail = 'Alex.iPhone.Japan@example.invalid';
  await email.fill(enteredEmail);
  await expect.poll(() => textContrast(email)).toBeGreaterThanOrEqual(4.5);
  await expect(email).toHaveValue(enteredEmail);
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
  await expect.poll(() => textContrast(email)).toBeGreaterThanOrEqual(4.5);
  await expect(email).toHaveValue(enteredEmail);
  expect(
    await page.evaluate(async () => (await document.fonts.load('12px "Geist Mono"')).length),
  ).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Create an account' }).click();
  await page.getByLabel('Name').fill('Alex Morgan');
  await page.getByLabel('Email address').fill(`${randomUUID()}@example.invalid`);
  await page.getByLabel('Password', { exact: true }).fill(randomUUID());
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.getByRole('link', { name: 'Account security', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Account security' })).toBeVisible();
  await expect(page.getByText('No connected tools or websites.')).toBeVisible();
  await page.getByRole('link', { name: 'Feedback', exact: true }).click();
  await page.getByRole('button', { name: 'Create your first project' }).click();
  await page.getByLabel('Project name').fill('Forma website');
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Installation' })).toBeVisible();
  await expect(page.getByText(/data-project="prj_/)).toBeVisible();
  const origins = page.getByLabel('Website origins');
  const enteredOrigins = 'http://localhost:44321\nhttps://iPhone.Japan.example';
  await origins.fill(enteredOrigins);
  const projectChoice = page.getByRole('combobox', { name: 'Project', exact: true });
  const selectedProject = projectChoice.locator('[data-slot="select-value"]');
  const colorSchemes: ('light' | 'dark')[] = ['light', 'dark'];
  for (const colorScheme of colorSchemes) {
    await page.emulateMedia({ colorScheme });
    await expect(page.locator('html')).toHaveAttribute('data-mode', colorScheme);
    await expect.poll(() => textContrast(origins)).toBeGreaterThanOrEqual(4.5);
    await expect(origins).toHaveValue(enteredOrigins);
    await expect(selectedProject).toHaveText('Forma website');
    await expect.poll(() => textContrast(selectedProject)).toBeGreaterThanOrEqual(4.5);
    await projectChoice.hover();
    await expect.poll(() => textContrast(selectedProject)).toBeGreaterThanOrEqual(4.5);
    await projectChoice.click();
    const option = page.getByRole('option', { name: 'Forma website', exact: true });
    await expect(option).toBeVisible();
    await expect.poll(() => textContrast(option)).toBeGreaterThanOrEqual(4.5);
    await option.hover();
    await expect.poll(() => textContrast(option)).toBeGreaterThanOrEqual(4.5);
    await page.keyboard.press('Escape');
  }
  await page.emulateMedia({ colorScheme: 'light' });
  await page.getByRole('link', { name: 'Appearance', exact: true }).click();
  const darkTab = page.getByRole('tab', { name: 'dark', exact: true });
  const lightTab = page.getByRole('tab', { name: 'light', exact: true });
  const systemTab = page.getByRole('tab', { name: 'system', exact: true });
  await darkTab.click();
  await expect(darkTab).toHaveAttribute('aria-selected', 'true');
  await expect(lightTab).toHaveAttribute('aria-selected', 'false');
  for (const tab of [darkTab, lightTab, systemTab])
    await expect.poll(() => textContrast(tab)).toBeGreaterThanOrEqual(4.5);
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
    await expect.poll(() => textContrast(control)).toBeGreaterThanOrEqual(4.5);
  await expect.poll(() => textContrast(previewMessage)).toBeGreaterThanOrEqual(4.5);
  await primary.hover();
  await expect.poll(() => textContrast(primary)).toBeGreaterThanOrEqual(4.5);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-mode', 'dark');
  for (const tab of [darkTab, lightTab, systemTab])
    await expect.poll(() => textContrast(tab)).toBeGreaterThanOrEqual(4.5);
  await lightTab.click();
  await expect(lightTab).toHaveAttribute('aria-selected', 'true');
  await expect(darkTab).toHaveAttribute('aria-selected', 'false');
  for (const tab of [darkTab, lightTab, systemTab])
    await expect.poll(() => textContrast(tab)).toBeGreaterThanOrEqual(4.5);
  await expect(primary.locator('xpath=ancestor::*[@data-slot="card"][1]')).toHaveCSS(
    'background-color',
    'rgb(255, 255, 255)',
  );
  await expect.poll(() => textContrast(previewMessage)).toBeGreaterThanOrEqual(4.5);
  await expect.poll(() => textContrast(secondary)).toBeGreaterThanOrEqual(4.5);
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
  await page.getByRole('link', { name: 'Feedback', exact: true }).click();
  const search = page.getByRole('textbox', { name: 'Search feedback' });
  await search.fill('magenta');
  await expect.poll(() => textContrast(search)).toBeGreaterThanOrEqual(4.5);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-mode', 'dark');
  await expect.poll(() => textContrast(search)).toBeGreaterThanOrEqual(4.5);
  await expect(search).toHaveValue('magenta');
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

test('isolated toolbar shares the service session and completes the feedback-to-agent loop', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && message.text().includes('Content Security Policy'))
      errors.push(message.text());
  });
  await signupFixture(page, {
    name: 'Taylor Review',
    email: `${randomUUID()}@example.invalid`,
    password: randomUUID(),
  });
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
  await expect(frame.getByRole('button', { name: 'Sign in to Feedback' })).toHaveCount(0);
  await expect(frame.locator('html')).toHaveAttribute('data-mode', 'dark');
  await expect(frame.locator('html')).toHaveCSS('--primary', '#788468');
  await expect(frame.locator('html')).toHaveCSS('--radius', '0px');
  await expect(frame.getByRole('button', { name: 'New feedback' })).toBeVisible({
    timeout: 15_000,
  });
  await page.evaluate(() => {
    const editing = document.createElement('section');
    editing.innerHTML =
      '<div id="editable-empty" contenteditable>Secret draft</div><div id="editable-plain" contenteditable="plaintext-only">Secret plaintext</div><div contenteditable><span id="editable-inherited">Inherited secret</span></div><div id="editable-parent">Public text <div contenteditable>Private child draft</div></div><div id="redacted-parent">Public controls <section data-feedback-redact>Unpublished owner metadata</section></div>';
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
  await page.locator('#redacted-parent').click({ position: { x: 5, y: 5 } });
  await expect(frame.getByText('Public controls', { exact: true })).toBeVisible();
  await expect(frame.getByText('Unpublished owner metadata', { exact: true })).toBeHidden();
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
  await frame.getByRole('button', { name: 'Add reaction', exact: true }).click();
  await frame.getByRole('textbox', { name: 'Search emojis', exact: true }).fill('thumbs up');
  await frame.getByRole('gridcell', { name: 'Thumbs up', exact: true }).click();
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
  await expect(page.locator('[data-feedback-host]')).toBeHidden();
  expect((await page.request.get('/api/me')).status()).toBe(401);
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
  await signupFixture(page, {
    name: 'Pagination reviewer',
    email: `${randomUUID()}@example.invalid`,
    password: randomUUID(),
  });
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

test('toolbar stays hidden for guests, reuses a later service login, and follows dashboard sign-out', async ({
  page,
}) => {
  await signupFixture(page, {
    name: 'Shared session reviewer',
    email: `${randomUUID()}@example.invalid`,
    password: randomUUID(),
  });
  const project = z.object({ project: projectSchema }).parse(
    await (
      await page.request.post('/api/projects', {
        data: { name: 'Shared browser session', origins: ['http://localhost:44321'] },
      })
    ).json(),
  ).project;
  const cookies = await page.context().cookies('http://localhost:44320');
  await page.context().clearCookies();
  await page.goto(`http://localhost:44321/?project=${project.id}`);
  const host = page.locator('[data-feedback-host]');
  await expect(host).toHaveCount(1);
  await expect(host).toBeHidden();
  await expect
    .poll(() => page.frames().some((frame) => frame.url().includes('/toolbar?')))
    .toBe(true);
  const frame = page.frames().find((frame) => frame.url().includes('/toolbar?'));
  if (!frame) throw new Error('Toolbar frame missing');
  await page.context().addCookies(cookies);
  await expect(host).toBeVisible({ timeout: 15_000 });
  await frame.getByRole('button', { name: 'Feedback', exact: false }).click();
  await expect(frame.getByRole('button', { name: 'New feedback' })).toBeVisible();
  await expect(frame.getByRole('button', { name: 'Sign in to Feedback' })).toHaveCount(0);
  const dashboard = await page.context().newPage();
  await dashboard.goto('http://localhost:44320/');
  await dashboard.getByRole('button', { name: 'Account menu', exact: true }).click();
  await dashboard.getByRole('menuitem', { name: 'Sign out', exact: true }).click();
  await expect(dashboard.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  await expect(host).toBeHidden({ timeout: 15_000 });
});

test('cookie-blocked toolbar requires explicit connection and ends with the approving session', async ({
  page,
}) => {
  await signupFixture(page, {
    name: 'Connected session reviewer',
    email: `${randomUUID()}@example.invalid`,
    password: randomUUID(),
  });
  const project = z.object({ project: projectSchema }).parse(
    await (
      await page.request.post('/api/projects', {
        data: { name: 'Cookie-blocked website', origins: ['http://localhost:44321'] },
      })
    ).json(),
  ).project;
  await page.route('**/api/me', (route) =>
    route.request().headers().authorization
      ? route.continue()
      : route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Browser blocked cookie access' }),
        }),
  );
  await page.goto(`http://localhost:44321/?project=${project.id}`);
  await expect(page.locator('[data-feedback-host]')).toBeHidden();
  await page.goto(`http://localhost:44321/?project=${project.id}#feedback-connect`);
  await expect(page).not.toHaveURL(/#feedback-connect/);
  await expect(page.locator('[data-feedback-host]')).toBeVisible();
  const frame = page.frames().find((frame) => frame.url().includes('/toolbar?'));
  if (!frame) throw new Error('Toolbar frame missing');
  await frame.getByRole('button', { name: 'Feedback', exact: false }).click();
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
  const signedOut = await page.request.post('/api/auth/sign-out', {
    headers: { Origin: 'http://localhost:44320' },
    data: {},
  });
  expect(signedOut.status()).toBe(200);
  await expect(page.locator('[data-feedback-host]')).toBeHidden({ timeout: 15_000 });
});
