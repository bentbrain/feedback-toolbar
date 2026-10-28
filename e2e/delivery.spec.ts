import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { test, expect } from './fixtures.js';
import { projectSchema, publicJobSchema, threadSchema } from '../src/shared/models.js';

test('interrupted work keeps remaining requirements and release evidence visible', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.request.post('/api/auth/sign-up/email', {
    data: { name: 'Owner', email: `${randomUUID()}@example.invalid`, password: randomUUID() },
  });
  const project = z.object({ project: projectSchema }).parse(
    await (
      await page.request.post('/api/projects', {
        data: { name: 'Delivery proof', origins: ['http://localhost:44321'] },
      })
    ).json(),
  ).project;
  const thread = z.object({ thread: threadSchema }).parse(
    await (
      await page.request.post(`/api/projects/${project.id}/threads`, {
        data: {
          body: 'Improve map detail and ordering.',
          context: {
            url: 'http://localhost:44321/',
            viewport: { width: 1280, height: 900 },
            deployment: null,
            anchor: {
              selector: '[data-feedback-id="hero"]',
              feedbackId: 'hero',
              tag: 'button',
              text: 'Synthetic map',
              label: '',
              rect: { x: 0, y: 0, width: 100, height: 30 },
            },
          },
        },
      })
    ).json(),
  ).thread;
  await page.request.post(`/api/threads/${thread.id}/work`, {
    data: { revision: thread.revision, idempotencyKey: randomUUID() },
  });
  const credential = z.object({ token: z.string() }).parse(
    await (
      await page.request.post(`/api/projects/${project.id}/credentials`, {
        data: { name: 'Delivery agent' },
      })
    ).json(),
  );
  const headers = { Authorization: `Bearer ${credential.token}` };
  const claim = z
    .object({ job: publicJobSchema, lease: z.string() })
    .parse(
      await (
        await page.request.post(`/api/projects/${project.id}/work/claim`, { headers, data: {} })
      ).json(),
    );
  const delivery = {
    stage: 'implemented',
    summary: 'Rejected overlay removed; original goal retained.',
    remaining: ['Implement better geographic context.'],
    runUrl: 't3-thread://v1/synthetic-run',
    pullRequestUrl: 'https://github.com/example/site/pull/1',
  };
  expect(
    (
      await page.request.patch(`/api/work/${claim.job.id}/delivery`, {
        headers,
        data: { lease: claim.lease, delivery },
      })
    ).status(),
  ).toBe(200);
  await page.request.post(`/api/work/${claim.job.id}/complete`, {
    headers,
    data: { lease: claim.lease, status: 'failed', body: 'Runner stopped. Existing work retained.' },
  });
  await page.goto('/');
  await page.getByText('Improve map detail and ordering.', { exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('region', { name: 'Delivery' })).toBeVisible();
  await expect(
    dialog.getByText('Implement better geographic context.', { exact: true }),
  ).toBeVisible();
  await expect(dialog.getByRole('link', { name: 'Pull request', exact: true })).toHaveAttribute(
    'href',
    delivery.pullRequestUrl,
  );
  const blocked = await page.request.patch(`/api/threads/${thread.id}`, {
    data: { status: 'resolved' },
  });
  expect(blocked.status()).toBe(409);
  if (process.env.FEEDBACK_DELIVERY_EVIDENCE) {
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.screenshot({
        path: `${process.env.FEEDBACK_DELIVERY_EVIDENCE}/remaining-${width}.png`,
        animations: 'disabled',
      });
    }
  }
  const resumed = z.object({ job: publicJobSchema, lease: z.string() }).parse(
    await (
      await page.request.post(`/api/work/${claim.job.id}/resume`, {
        headers,
        data: {
          inspection: 'Inspected original PR and source; continue replacement work.',
          runId: 'synthetic-recovery',
        },
      })
    ).json(),
  );
  expect(resumed.job.delivery?.details.remaining).toEqual(delivery.remaining);
  await page.request.post(`/api/work/${claim.job.id}/complete`, {
    headers,
    data: { lease: resumed.lease, status: 'review', body: 'Replacement implemented and reviewed.' },
  });
  const verified = {
    ...delivery,
    stage: 'verified',
    summary: 'Map detail and ordering verified in production.',
    remaining: [],
    commit: 'a'.repeat(40),
    reviewUrl: 'https://example.invalid/review',
    deploymentUrl: 'https://example.invalid/deploy',
    verificationUrl: 'https://example.invalid/proof',
  };
  expect(
    (
      await page.request.patch(`/api/work/${claim.job.id}/delivery`, {
        headers,
        data: { delivery: verified },
      })
    ).status(),
  ).toBe(200);
  await expect(dialog.getByText('Verified in production', { exact: true }).first()).toBeVisible({
    timeout: 15_000,
  });
  await expect(
    dialog.getByText('Implement better geographic context.', { exact: true }),
  ).toHaveCount(0);
  await expect(dialog.getByRole('link', { name: 'Deployment', exact: true })).toHaveAttribute(
    'href',
    verified.deploymentUrl,
  );
  await dialog.getByRole('button', { name: 'Resolve', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Reopen', exact: true })).toBeVisible();
});
