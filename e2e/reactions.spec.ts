import type { Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import emojiData from 'emojibase-data/en/data.json' with { type: 'json' };
import { test, expect } from './fixtures.js';
import { emojiSchema, projectSchema, threadSchema } from '../src/shared/models.js';

async function fixture(page: Page, baseURL: string | undefined, dark = false) {
  if (!baseURL) throw new Error('Missing fixture URL.');
  const website = new URL(baseURL);
  website.port = String(Number(website.port) + 1);
  expect(
    (
      await page.request.post('/api/auth/sign-up/email', {
        data: {
          name: 'Emoji reviewer',
          email: `${randomUUID()}@example.invalid`,
          password: randomUUID(),
        },
      })
    ).status(),
  ).toBe(200);
  const project = z.object({ project: projectSchema }).parse(
    await (
      await page.request.post('/api/projects', {
        data: {
          name: 'Emoji website',
          origins: [website.origin],
          theme: { mode: dark ? 'dark' : 'light' },
        },
      })
    ).json(),
  ).project;
  const thread = z.object({ thread: threadSchema }).parse(
    await (
      await page.request.post(`/api/projects/${project.id}/threads`, {
        data: {
          body: 'Searchable emoji feedback',
          context: {
            url: website.href,
            viewport: { width: 1280, height: 800 },
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
    ).json(),
  ).thread;
  const messageId = thread.messages[0]?.id;
  if (!messageId) throw new Error('Missing fixture message.');
  expect(
    (
      await page.request.post(`/api/threads/${thread.id}/reactions`, {
        data: { messageId, emoji: '👨‍👩‍👧‍👦' },
      })
    ).status(),
  ).toBe(200);
  return { project, thread, website, baseURL };
}

function capture(page: Page) {
  const errors: string[] = [];
  const requests: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('request', (request) => requests.push(request.url()));
  return { errors, requests };
}

// WebKit screenshot preparation injects nonce-free CSS; keep functional CSP checks screenshot-free.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (event) => {
      if (event.effectiveDirective.startsWith('style-src'))
        console.error(`Blocked stylesheet: ${event.effectiveDirective}`);
    });
  });
});

test('dashboard searches, selects, persists and toggles arbitrary reactions with keyboard and skin tones', async ({
  page,
  baseURL,
}) => {
  const f = await fixture(page, baseURL);
  const { errors, requests } = capture(page);
  await page.goto('/');
  await page.getByText('Searchable emoji feedback', { exact: true }).click();
  const dialog = page
    .getByRole('dialog')
    .filter({ has: page.getByText('Searchable emoji feedback', { exact: true }) });
  await expect(dialog.getByRole('button', { name: 'React with 👨‍👩‍👧‍👦', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  for (const emoji of ['👍', '❤️', '👀', '🎉']) {
    await expect(
      dialog.getByRole('button', { name: `React with ${emoji}`, exact: true }),
    ).toHaveCount(0);
  }
  expect(requests.filter((url) => url.includes('/emoji-data/'))).toEqual([]);
  await dialog.getByRole('button', { name: 'Add reaction', exact: true }).click();
  const search = page.getByRole('textbox', { name: 'Search emojis', exact: true });
  await expect(search).toBeFocused();
  let releaseReaction: () => void = () => {
    throw new Error('Reaction request was not initialized.');
  };
  const reactionPending = new Promise<void>((resolve) => {
    releaseReaction = resolve;
  });
  await page.route(`**/api/threads/${f.thread.id}/reactions`, async (route) => {
    await reactionPending;
    await route.continue();
  });
  await search.fill('butterfly');
  const butterfly = page.getByRole('gridcell', { name: 'Butterfly', exact: true });
  await expect(butterfly).toBeVisible();
  await search.press('ArrowDown');
  await search.press('Enter');
  await expect(search).toHaveCount(0);
  const group = dialog.getByRole('group', { name: 'Reactions', exact: true });
  await expect(group).toHaveAttribute('aria-busy', 'true');
  await expect(group.getByRole('button', { name: 'Add reaction', exact: true })).toBeDisabled();
  await expect(group.getByRole('button', { name: 'React with 👨‍👩‍👧‍👦', exact: true })).toBeDisabled();
  releaseReaction();
  const reaction = dialog.getByRole('button', { name: 'React with 🦋', exact: true });
  await expect(reaction).toHaveAttribute('aria-pressed', 'true');
  await expect(reaction).toHaveText('🦋');
  await reaction.click();
  await expect(reaction).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Add reaction', exact: true }).click();
  await search.fill('thumbs up');
  await expect(page.getByRole('gridcell', { name: 'Thumbs up', exact: true })).toBeVisible();
  await page.getByRole('button', { name: /^Change skin tone/ }).click();
  await page.getByRole('button', { name: /^Change skin tone/ }).click();
  await page.getByRole('button', { name: /^Change skin tone/ }).click();
  await expect(page.getByRole('gridcell', { name: 'Thumbs up', exact: true })).toHaveText('👍🏽');
  await page.getByRole('gridcell', { name: 'Thumbs up', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'React with 👍🏽', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.reload();
  await page.getByText('Searchable emoji feedback', { exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'React with 👍🏽', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await dialog.getByRole('button', { name: 'Add reaction', exact: true }).click();
  await search.fill('doesnotexistemoji');
  await expect(page.getByText('No emoji found.', { exact: true })).toBeVisible();
  await search.press('Escape');
  await expect(search).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Add reaction', exact: true })).toBeFocused();
  expect(requests.some((url) => url.endsWith('/api/emoji-data/v1/en/data.json'))).toBe(true);
  expect(requests.some((url) => url.endsWith('/api/emoji-data/v1/en/messages.json'))).toBe(true);
  expect(requests.every((url) => new URL(url).origin === f.baseURL)).toBe(true);
  expect(errors).toEqual([]);
});

test('favourites learn choices, rank frequent emojis and persist across reloads', async ({
  page,
  baseURL,
}) => {
  await fixture(page, baseURL);
  await page.goto('/');
  await page.getByText('Searchable emoji feedback', { exact: true }).click();
  const reactions = page.getByRole('group', { name: 'Reactions', exact: true });
  const add = reactions.getByRole('button', { name: 'Add reaction', exact: true });
  const search = page.getByRole('textbox', { name: 'Search emojis', exact: true });
  const favourites = page.getByRole('group', { name: 'Favourite emojis', exact: true });
  await add.click();
  await expect(favourites).toHaveCount(0);
  await search.fill('butterfly');
  await page.getByRole('gridcell', { name: 'Butterfly', exact: true }).click();
  const butterfly = reactions.getByRole('button', { name: 'React with 🦋', exact: true });
  await expect(butterfly).toHaveAttribute('aria-pressed', 'true');
  await butterfly.click();
  await expect(butterfly).toHaveCount(0);
  await add.click();
  await favourites.getByRole('button', { name: 'React with 🦋', exact: true }).click();
  await expect(butterfly).toHaveAttribute('aria-pressed', 'true');
  await add.click();
  await search.fill('rocket');
  await page.getByRole('gridcell', { name: 'Rocket', exact: true }).click();
  await expect(
    reactions.getByRole('button', { name: 'React with 🚀', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await page.reload();
  await page.getByText('Searchable emoji feedback', { exact: true }).click();
  await add.click();
  await expect(favourites.getByRole('button')).toHaveText(['🦋', '🚀']);
  await search.press('Escape');
  await reactions.getByRole('button', { name: 'React with 🚀', exact: true }).click();
  await add.click();
  // Removing a reaction does not count as another choice.
  await expect(favourites.getByRole('button')).toHaveText(['🦋', '🚀']);
  await favourites.getByRole('button', { name: 'React with 🚀', exact: true }).click();
  await expect(
    reactions.getByRole('button', { name: 'React with 🚀', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await add.click();
  // Equally frequent choices put the most recent one first.
  await expect(favourites.getByRole('button')).toHaveText(['🚀', '🦋']);
});

test('favourites combine choices from separate tabs without losing updates', async ({
  page,
  baseURL,
}) => {
  await fixture(page, baseURL);
  const other = await page.context().newPage();
  for (const tab of [page, other]) {
    await tab.goto('/');
    await tab.getByText('Searchable emoji feedback', { exact: true }).click();
    await tab.getByRole('button', { name: 'Add reaction', exact: true }).click();
    await expect(tab.getByRole('group', { name: 'Favourite emojis', exact: true })).toHaveCount(0);
  }
  await page.getByRole('textbox', { name: 'Search emojis', exact: true }).fill('butterfly');
  await other.getByRole('textbox', { name: 'Search emojis', exact: true }).fill('rocket');
  await Promise.all([
    page.getByRole('gridcell', { name: 'Butterfly', exact: true }).click(),
    other.getByRole('gridcell', { name: 'Rocket', exact: true }).click(),
  ]);
  for (const tab of [page, other]) {
    const add = tab.getByRole('button', { name: 'Add reaction', exact: true });
    await expect(add).toBeEnabled();
    await add.click();
    const favourites = tab.getByRole('group', { name: 'Favourite emojis', exact: true });
    await expect(
      favourites.getByRole('button', { name: 'React with 🦋', exact: true }),
    ).toBeVisible();
    await expect(
      favourites.getByRole('button', { name: 'React with 🚀', exact: true }),
    ).toBeVisible();
  }
  await other.close();
});

test('frequent favourites survive more than 32 distinct choices', async ({ page, baseURL }) => {
  const f = await fixture(page, baseURL);
  const actorId = f.thread.messages[0]?.actorId;
  if (!actorId) throw new Error('Missing fixture actor.');
  await page.goto('/');
  const history = emojiData
    .filter((entry) => entry.group !== undefined && emojiSchema.safeParse(entry.emoji).success)
    .filter((entry) => !['🦋', '🚀'].includes(entry.emoji))
    .slice(0, 31)
    .map(({ emoji }) => ({ emoji, count: 1 }));
  history.push({ emoji: '🦋', count: 20 });
  await page.evaluate(
    ({ actorId, history }) => {
      localStorage.setItem(`feedback-emoji-favourites-v1:${actorId}`, JSON.stringify(history));
    },
    { actorId, history },
  );
  await page.getByText('Searchable emoji feedback', { exact: true }).click();
  const add = page.getByRole('button', { name: 'Add reaction', exact: true });
  await add.click();
  await page.getByRole('textbox', { name: 'Search emojis', exact: true }).fill('rocket');
  await page.getByRole('gridcell', { name: 'Rocket', exact: true }).click();
  await expect(add).toBeEnabled();
  await page.reload();
  await page.getByText('Searchable emoji feedback', { exact: true }).click();
  await add.click();
  const favourites = page.getByRole('group', { name: 'Favourite emojis', exact: true });
  await expect(favourites.getByRole('button').first()).toHaveText('🦋');
});

test('mobile dark toolbar picker fits its iframe, inherits theme and isolates host styles', async ({
  page,
  baseURL,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const f = await fixture(page, baseURL, true);
  const { errors, requests } = capture(page);
  await page.goto(`${f.website.origin}/?project=${f.project.id}`);
  await expect
    .poll(() => page.frames().some((frame) => frame.url().includes('/toolbar?')))
    .toBe(true);
  const frame = page.frames().find((frame) => frame.url().includes('/toolbar?'));
  if (!frame) throw new Error('Toolbar frame missing.');
  await frame.getByRole('button', { name: 'Feedback', exact: false }).click();
  await frame.getByText('Searchable emoji feedback', { exact: true }).click();
  const add = frame.getByRole('button', { name: 'Add reaction', exact: true });
  const touch = test.info().project.use.hasTouch;
  if (touch) await add.tap();
  else await add.click();
  const popup = frame.locator('[data-slot="popover-content"]');
  const search = frame.getByRole('textbox', { name: 'Search emojis', exact: true });
  if (touch) {
    await expect(popup).toBeFocused();
    await search.tap();
  }
  await expect(search).toBeFocused();
  await search.fill('rocket');
  await expect(frame.getByRole('gridcell', { name: 'Rocket', exact: true })).toBeVisible();
  const geometry = await popup.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      width: innerWidth,
      height: innerHeight,
      dark: document.documentElement.classList.contains('dark'),
      background: getComputedStyle(element).backgroundColor,
    };
  });
  expect(geometry.left).toBeGreaterThanOrEqual(0);
  expect(geometry.right).toBeLessThanOrEqual(geometry.width);
  expect(geometry.top).toBeGreaterThanOrEqual(0);
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.height);
  expect(geometry.dark).toBe(true);
  expect(geometry.background).not.toBe('rgba(0, 0, 0, 0)');
  await page.addStyleTag({
    content: 'button,input{font-size:64px!important;background:red!important}',
  });
  await expect(search).toHaveCSS('font-size', touch ? '16px' : '12px');
  const rocket = frame.getByRole('gridcell', { name: 'Rocket', exact: true });
  if (touch) await rocket.tap();
  else await rocket.click();
  await expect(frame.getByRole('button', { name: 'React with 🚀', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(requests.every((url) => [f.baseURL, f.website.origin].includes(new URL(url).origin))).toBe(
    true,
  );
  expect(errors).toEqual([]);
});

test('picker data failure can be retried without breaking the conversation', async ({
  page,
  baseURL,
}) => {
  await fixture(page, baseURL);
  const styleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && /Content Security Policy|stylesheet/.test(message.text()))
      styleErrors.push(message.text());
  });
  await page.route('**/api/emoji-data/v1/en/*.json', (route) => route.abort());
  await page.goto('/');
  await page.getByText('Searchable emoji feedback', { exact: true }).click();
  const add = page.getByRole('button', { name: 'Add reaction', exact: true });
  await add.click();
  await expect(page.getByRole('alert')).toContainText('Could not load emojis.');
  const retry = page.getByRole('button', { name: 'Retry', exact: true });
  await expect(retry).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(add).toBeVisible();
  await expect(add).toBeFocused();
  await add.click();
  await expect(page.getByRole('alert')).toContainText('Could not load emojis.');
  await expect(retry).toBeFocused();
  await page.unroute('**/api/emoji-data/v1/en/*.json');
  if (test.info().project.use.hasTouch) await retry.tap();
  else await retry.click();
  const search = page.getByRole('textbox', { name: 'Search emojis', exact: true });
  await expect(search).toBeFocused();
  await search.fill('butterfly');
  await page.getByRole('gridcell', { name: 'Butterfly', exact: true }).click();
  await expect(page.getByRole('button', { name: 'React with 🦋', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(styleErrors).toEqual([]);
});

test.describe('touch emoji grid', () => {
  test.use({ hasTouch: true });

  test('unfiltered emoji rows fit the popup when the phone width changes', async ({
    page,
    baseURL,
  }) => {
    await fixture(page, baseURL);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await page.getByText('Searchable emoji feedback', { exact: true }).click();
    await page.getByRole('button', { name: 'Add reaction', exact: true }).click();
    const popup = page.locator('[data-slot="popover-content"]');
    const cells = popup.getByRole('gridcell');
    await expect(cells.first()).toBeVisible();
    for (const width of [390, 320, 260]) {
      await page.setViewportSize({ width, height: 844 });
      await expect
        .poll(() =>
          cells.evaluateAll((elements) =>
            elements.flatMap((element) => {
              const bounds = element.getBoundingClientRect();
              const viewport = element.closest('[data-slot="emoji-picker-viewport"]');
              if (!viewport) throw new Error('Emoji viewport missing');
              const clip = viewport.getBoundingClientRect();
              return bounds.left < clip.left - 1 ||
                bounds.right > clip.left + viewport.clientWidth + 1
                ? [element.getAttribute('aria-label')]
                : [];
            }),
          ),
        )
        .toEqual([]);
      await expect
        .poll(async () => (await cells.first().boundingBox())?.width)
        .toBeGreaterThanOrEqual(44);
    }
    await cells.first().click();
    await expect(popup).toBeHidden();
  });
});
