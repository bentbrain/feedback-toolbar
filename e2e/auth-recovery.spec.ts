import { randomUUID } from 'node:crypto';
import { test, expect } from './fixtures.js';
import { z } from 'zod';
import { projectSchema } from '../src/shared/models.js';

test('a rejected real grant refresh permits explicit reapproval', async ({ page }) => {
  expect(
    (
      await page.request.post('/api/auth/sign-up/email', {
        data: { name: 'Review', email: `${randomUUID()}@example.invalid`, password: randomUUID() },
      })
    ).status(),
  ).toBe(200);
  const project = z.object({ project: projectSchema }).parse(
    await (
      await page.request.post('/api/projects', {
        data: { name: 'Recovery', origins: ['http://localhost:44321'] },
      })
    ).json(),
  ).project;
  await page.route('**/api/me', (route) =>
    route.request().headers().authorization
      ? route.continue()
      : route.fulfill({ status: 401, json: { error: 'Cookie unavailable' } }),
  );
  await page.goto(`http://localhost:44321/?project=${project.id}#feedback-connect`);
  const host = page.locator('[data-feedback-host]');
  await expect(host).toBeVisible();
  const frame = page.frames().find((frame) => frame.url().includes('/toolbar?'));
  if (!frame) throw new Error('Frame missing');
  await frame.getByRole('button', { name: 'Feedback', exact: false }).click();
  const opened = page.waitForEvent('popup');
  await frame.getByRole('button', { name: 'Sign in to Feedback' }).click();
  const popup = await opened;
  await popup.waitForURL(/\/auth\?user_code=/);
  await popup.getByRole('button', { name: 'Approve connection' }).click();
  await expect(popup.getByText('Connection approved.')).toBeVisible();
  await popup.close();
  await expect(frame.getByRole('button', { name: 'New feedback' })).toBeVisible({ timeout: 15000 });
  const rejected = page.waitForResponse(
    (response) => response.url().endsWith('/api/auth/oauth2/token') && response.status() === 400,
  );
  expect(
    (
      await page.request.post('/api/auth/sign-out', {
        headers: { Origin: 'http://localhost:44320' },
        data: {},
      })
    ).status(),
  ).toBe(200);
  await frame.evaluate(() => {
    for (const name of Object.keys(localStorage)) {
      if (!name.startsWith('feedback-connection:')) continue;
      const record: unknown = JSON.parse(localStorage.getItem(name) ?? 'null');
      if (typeof record !== 'object' || record === null || !('connection' in record)) continue;
      const connection = record.connection;
      if (typeof connection !== 'object' || connection === null || !('expiresAt' in connection))
        continue;
      connection.expiresAt = Date.now() - 1;
      localStorage.setItem(name, JSON.stringify(record));
    }
  });
  await rejected;
  await expect(host).toBeHidden({ timeout: 15000 });
  await page.evaluate(() => {
    location.hash = 'feedback-connect';
  });
  await expect(page).not.toHaveURL(/#feedback-connect/);
  await expect(host).toBeVisible({ timeout: 3000 });
  await expect(frame.getByRole('button', { name: 'Sign in to Feedback' })).toBeVisible();
});
