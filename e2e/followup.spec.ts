import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { test, expect } from './fixtures.js';
import { projectSchema, publicJobSchema, threadSchema } from '../src/shared/models.js';

for (const submission of ['toolbar', 'dashboard']) {
  test(`completed frozen work leaves newer owner feedback visibly unsubmitted via ${submission}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.request.post('/api/auth/sign-up/email', {
      data: { name: 'Owner', email: `${randomUUID()}@example.invalid`, password: randomUUID() },
    });
    const project = z.object({ project: projectSchema }).parse(
      await (
        await page.request.post('/api/projects', {
          data: {
            name: 'Map feedback',
            origins: ['http://localhost:44321'],
            theme: { mode: 'light' },
          },
        })
      ).json(),
    ).project;
    const thread = z.object({ thread: threadSchema }).parse(
      await (
        await page.request.post(`/api/projects/${project.id}/threads`, {
          data: {
            body: 'Fix drag selection on the map.',
            context: {
              url: 'http://localhost:44321/',
              viewport: { width: 1280, height: 900 },
              deployment: null,
              anchor: {
                selector: '[data-feedback-id="hero-button"]',
                feedbackId: 'hero-button',
                tag: 'button',
                text: 'Get started',
                label: '',
                rect: { x: 0, y: 0, width: 100, height: 30 },
              },
            },
          },
        })
      ).json(),
    ).thread;
    await page.goto(`http://localhost:44321/?project=${project.id}`);
    await expect
      .poll(() => page.frames().some((frame) => frame.url().includes('/toolbar?')))
      .toBe(true);
    const frame = page.frames().find((frame) => frame.url().includes('/toolbar?'));
    if (!frame) throw new Error('Toolbar missing.');
    await frame.getByRole('button', { name: 'Feedback', exact: false }).click();
    await frame.getByText('Fix drag selection on the map.', { exact: true }).click();
    await frame.getByRole('button', { name: 'Send to agent', exact: true }).click();
    await expect(frame.getByText('Queued. Waiting for the agent.')).toBeVisible();
    const credential = z.object({ token: z.string() }).parse(
      await (
        await page.request.post(`/api/projects/${project.id}/credentials`, {
          data: { name: 'Map agent' },
        })
      ).json(),
    );
    const headers = { Authorization: `Bearer ${credential.token}` };
    const claim = z
      .object({ job: publicJobSchema.extend({ snapshot: threadSchema }), lease: z.string() })
      .parse(
        await (
          await page.request.post(`/api/projects/${project.id}/work/claim`, { headers, data: {} })
        ).json(),
      );
    await frame
      .getByLabel('Reply', { exact: true })
      .fill('Also show roads and highways on the map.');
    await frame.getByRole('button', { name: 'Reply', exact: true }).click();
    await expect(
      frame.getByText('Also show roads and highways on the map.', { exact: true }),
    ).toBeVisible();
    expect(claim.job.snapshot.messages.map((message) => message.body)).toEqual([
      'Fix drag selection on the map.',
    ]);
    const complete = await page.request.post(`/api/work/${claim.job.id}/complete`, {
      headers,
      data: {
        lease: claim.lease,
        status: 'review',
        body: 'Drag selection fixed. Ready for review.',
      },
    });
    expect(complete.status()).toBe(200);
    await expect(
      frame.getByText('Drag selection fixed. Ready for review.', { exact: true }),
    ).toBeVisible({ timeout: 10_000 });
    if (process.env.FEEDBACK_FOLLOWUP_EVIDENCE && submission === 'toolbar') {
      await page.screenshot({
        animations: 'disabled',
        path: `${process.env.FEEDBACK_FOLLOWUP_EVIDENCE}/toolbar.png`,
      });
      await frame.getByRole('button', { name: 'Back to feedback', exact: true }).click();
      await page.screenshot({
        animations: 'disabled',
        path: `${process.env.FEEDBACK_FOLLOWUP_EVIDENCE}/toolbar-list.png`,
      });
      await frame.getByText('Fix drag selection on the map.', { exact: true }).click();
      const dashboard = await page.context().newPage();
      await dashboard.setViewportSize({ width: 1280, height: 900 });
      await dashboard.emulateMedia({ reducedMotion: 'reduce' });
      await dashboard.goto('/');
      await dashboard.getByText('Fix drag selection on the map.', { exact: true }).click();
      await expect(
        dashboard.getByText('Drag selection fixed. Ready for review.', { exact: true }),
      ).toBeVisible();
      await expect(dashboard.getByRole('dialog')).toHaveCSS('opacity', '1');
      await dashboard.screenshot({
        animations: 'disabled',
        path: `${process.env.FEEDBACK_FOLLOWUP_EVIDENCE}/dashboard.png`,
      });
      await dashboard.keyboard.press('Escape');
      await dashboard.screenshot({
        animations: 'disabled',
        path: `${process.env.FEEDBACK_FOLLOWUP_EVIDENCE}/dashboard-list.png`,
      });
      await dashboard.close();
    }
    await expect(frame.getByText('New feedback not sent to agent', { exact: true })).toBeVisible();
    await expect(
      frame.getByRole('status').filter({ hasText: 'New feedback not sent to agent' }),
    ).toBeInViewport();
    const send = frame.getByRole('button', { name: 'Send remaining feedback', exact: true });
    await expect(send).toBeEnabled();
    await frame.getByRole('button', { name: 'Back to feedback', exact: true }).click();
    await expect(frame.getByText('New feedback not sent to agent', { exact: true })).toBeVisible();
    await frame.getByText('Fix drag selection on the map.', { exact: true }).click();
    if (submission === 'dashboard') {
      const dashboard = await page.context().newPage();
      await dashboard.setViewportSize({ width: 1280, height: 900 });
      await dashboard.emulateMedia({ reducedMotion: 'reduce' });
      await dashboard.goto('/');
      await expect(
        dashboard.getByText('New feedback not sent to agent', { exact: true }),
      ).toBeVisible();
      await dashboard.getByText('Fix drag selection on the map.', { exact: true }).click();
      await expect(
        dashboard.getByRole('status').filter({ hasText: 'New feedback not sent to agent' }),
      ).toBeInViewport();
      await dashboard.getByRole('button', { name: 'Send remaining feedback', exact: true }).click();
      await expect(dashboard.getByText('Queued. Waiting for the agent.')).toBeVisible();
      await expect(
        dashboard.getByText('New feedback not sent to agent', { exact: true }),
      ).toHaveCount(0);
      await dashboard.close();
    } else {
      await send.click();
    }
    await expect(frame.getByText('Queued. Waiting for the agent.')).toBeVisible();
    await expect(frame.getByText('New feedback not sent to agent', { exact: true })).toHaveCount(0);
    const next = z
      .object({ job: publicJobSchema.extend({ snapshot: threadSchema }), lease: z.string() })
      .parse(
        await (
          await page.request.post(`/api/projects/${project.id}/work/claim`, { headers, data: {} })
        ).json(),
      );
    expect(next.job.id).not.toBe(claim.job.id);
    expect(
      next.job.snapshot.messages.some((message) => message.body.includes('roads and highways')),
    ).toBe(true);
    expect(next.job.revision).toBeGreaterThan(thread.revision);
  });
}
