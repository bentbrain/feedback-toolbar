import { test, expect } from '@playwright/test';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { projectSchema, publicJobSchema, threadSchema } from '../src/shared/models.js';

test('new user creates a project, customizes its theme, and gets the installation snippet', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create an account' }).click();
  await page.getByLabel('Your name').fill('Alex Morgan');
  await page.getByLabel('Email address').fill(`${randomUUID()}@example.invalid`);
  await page.getByLabel('Password', { exact: true }).fill(randomUUID());
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.getByRole('button', { name: 'Create your first project' }).click();
  await page.getByLabel('Project name').fill('Forma website');
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Make room for feedback.' })).toBeVisible();
  await expect(page.getByText(/data-project="prj_/)).toBeVisible();
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  await page.getByRole('tab', { name: 'dark', exact: true }).click();
  await page.getByRole('button', { name: 'Use #72865d', exact: true }).click();
  await page.getByRole('button', { name: 'Save appearance', exact: true }).click();
  await expect(page.getByText('All changes saved')).toBeVisible();
  const state = await page.request.get('/api/projects');
  const result = z.object({ projects: z.array(projectSchema) }).parse(await state.json());
  expect(result.projects[0]?.theme.mode).toBe('dark');
  expect(result.projects[0]?.theme.accent).toBe('#72865d');
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
  const account = await page.request.post('/api/auth/signup', {
    data: {
      name: 'Taylor Review',
      email: `${randomUUID()}@example.invalid`,
      password: randomUUID(),
    },
  });
  expect(account.status()).toBe(201);
  const created = await page.request.post('/api/projects', {
    data: { name: 'Toolbar test', origins: ['http://localhost:4321'] },
  });
  const project = z.object({ project: projectSchema }).parse(await created.json()).project;
  await page.goto(`http://localhost:4321/?project=${project.id}`);
  await expect
    .poll(() => page.frames().some((frame) => frame.url().includes('/toolbar?')))
    .toBe(true);
  const frame = page.frames().find((frame) => frame.url().includes('/toolbar?'));
  if (!frame) throw new Error('Toolbar frame missing.');
  await frame.getByRole('button', { name: 'Feedback', exact: false }).click();
  await expect(frame.getByRole('button', { name: 'Sign in to Feedback' })).toBeVisible();
  const popupPromise = page.waitForEvent('popup');
  await frame.getByRole('button', { name: 'Sign in to Feedback' }).click();
  const popup = await popupPromise;
  await popup.waitForURL(/\/auth\?grant=/);
  await popup.getByRole('button', { name: 'Approve connection' }).click();
  await expect(popup.getByText('Connection approved.')).toBeVisible();
  await popup.close();
  await expect(frame.getByRole('button', { name: 'New feedback' })).toBeVisible();
  await frame.getByRole('button', { name: 'New feedback' }).click();
  await page.locator('[data-feedback-id=hero-button]').click();
  await frame
    .getByLabel('What would you like to change?')
    .fill('Please increase the spacing around this button.');
  const postedPromise = page.waitForResponse(
    (response) => response.url().includes('/threads') && response.request().method() === 'POST',
    { timeout: 5000 },
  );
  await frame.getByRole('button', { name: 'Post feedback' }).click();
  const posted = await postedPromise;
  expect(posted.status()).toBe(201);
  await expect(frame.getByText('Please increase the spacing around this button.')).toBeVisible();
  await frame.getByRole('button', { name: 'React with 👍' }).click();
  await frame.getByRole('button', { name: 'Send to agent' }).click();
  await expect(
    frame.getByText('Waiting for your local connector. Your request is saved.'),
  ).toBeVisible();
  const data = z
    .object({ threads: z.array(threadSchema) })
    .parse(await (await page.request.get(`/api/projects/${project.id}/threads`)).json());
  expect(data.threads[0]?.context.anchor.feedbackId).toBe('hero-button');
  expect(data.threads[0]?.messages[0]?.reactions.length).toBe(1);
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
  expect(errors).toEqual([]);
});
