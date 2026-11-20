import { expect } from '@stablyai/playwright-test'
import { test } from '../../desktop/electron-fixtures/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from '../../desktop/renderer-probes/store'
import {
  CHAT_ID,
  HOME_CHAT_ID,
  bot,
  capture,
  drawsRevealGlow,
  expectRevealed,
  filterDialog,
  foldBots,
  listedInProjects,
  openScene,
  readAfter,
  stubBot,
  workerLineage
} from './bot-reveal-scene'
import { secondaryWorktree, seedSendTarget } from './bot-reveal-workspaces'

// The owner's report: with a sidebar filter on and bot work in front, the reveal button asked
// "Reveal hidden workspace?" and adjusting the filters did nothing; on a bot's chat it did nothing at
// all. A bot's chats and its worker workspaces live in the Bots section, so "Reveal current" must
// reveal them there and never touch the Projects filters.

test.describe('Reveal current on bot work', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await orcaPage.emulateMedia({ reducedMotion: 'reduce' })
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
  })

  test('a bot chat reveals in Bots, with no filter dialog', async ({
    electronApp,
    orcaPage: page
  }) => {
    await stubBot(electronApp, {})
    await openScene(page, { kind: 'chat' })
    await foldBots(page)
    const entry = page.locator(`[data-bot-sidebar-entry="local/${bot.id}"]`)
    await capture(page, 'bot-chat-before.png')

    await page.getByRole('button', { name: 'Reveal current' }).click()

    // Bots unfolds, then the bot, and its chat row is the current, revealed row.
    const chatRow = entry.locator(`[data-bot-sidebar-chat="${CHAT_ID}"]`)
    await expect(chatRow).toBeVisible()
    await expect(chatRow).toHaveAttribute('aria-current', 'true')
    await expectRevealed(chatRow)
    // Only the revealed row glows.
    expect(await drawsRevealGlow(entry.locator(`[data-bot-sidebar-chat="${HOME_CHAT_ID}"]`))).toBe(
      false
    )
    await expect(filterDialog(page)).toHaveCount(0)
    expect(await readAfter(page)).toEqual({ showSleeping: false, pending: null })
    await capture(page, 'bot-chat-after.png')
  })

  test("a bot's page reveals its Home chat in Bots, with no filter dialog", async ({
    electronApp,
    orcaPage: page
  }) => {
    await stubBot(electronApp, {})
    await openScene(page, { kind: 'page' })
    await foldBots(page)
    const entry = page.locator(`[data-bot-sidebar-entry="local/${bot.id}"]`)
    await capture(page, 'bot-page-before.png')

    await page.getByRole('button', { name: 'Reveal current' }).click()

    const homeRow = entry.locator(`[data-bot-sidebar-chat="${HOME_CHAT_ID}"]`)
    await expect(homeRow).toBeVisible()
    await expect(homeRow).toHaveAttribute('aria-current', 'true')
    await expectRevealed(homeRow)
    await expect(filterDialog(page)).toHaveCount(0)
    expect(await readAfter(page)).toEqual({ showSleeping: false, pending: null })
    await capture(page, 'bot-page-after.png')
  })

  test('a bot worker workspace reveals under its chat in Bots, with no filter dialog', async ({
    electronApp,
    orcaPage: page,
    testRepoPath
  }) => {
    const worker = await secondaryWorktree(page, testRepoPath)
    const lineage = workerLineage(worker)
    await stubBot(electronApp, { [worker.worktreeId]: CHAT_ID }, lineage)
    await openScene(page, { kind: 'worker', ...worker, lineage })
    // Hide bot workspaces is on: once the bot is listed, Projects no longer lists its worker.
    await expect.poll(() => listedInProjects(page, worker.worktreeId)).toBe(false)
    await foldBots(page)
    await expect.poll(() => listedInProjects(page, worker.worktreeId)).toBe(false)
    const entry = page.locator(`[data-bot-sidebar-entry="local/${bot.id}"]`)
    await capture(page, 'bot-worker-before.png')

    await page.getByRole('button', { name: 'Reveal current' }).click()

    const card = entry
      .locator(`[data-bot-sidebar-line$="${worker.worktreeId}"] [data-worktree-card-surface]`)
      .first()
    await expect(card).toBeVisible()
    await expectRevealed(card)
    await expect(filterDialog(page)).toHaveCount(0)
    expect(await readAfter(page)).toEqual({ showSleeping: false, pending: null })
    await capture(page, 'bot-worker-after.png')
  })

  test('a Bots search whose results hide the bot ends, and its chat reveals', async ({
    electronApp,
    orcaPage: page
  }) => {
    await stubBot(electronApp, {})
    await openScene(page, { kind: 'chat' })
    const entry = page.locator(`[data-bot-sidebar-entry="local/${bot.id}"]`)
    await expect(entry).toBeVisible()
    await page.getByRole('button', { name: 'Search bots', exact: true }).click()
    // A query that excludes the bot in front: its results replace the list.
    await page.getByRole('searchbox', { name: 'Search bots' }).fill('nothing like it')
    await expect(entry).toBeHidden()
    await capture(page, 'bot-search-before.png')

    await page.getByRole('button', { name: 'Reveal current' }).click()

    await expect(page.getByRole('searchbox', { name: 'Search bots' })).toHaveCount(0)
    const chatRow = entry.locator(`[data-bot-sidebar-chat="${CHAT_ID}"]`)
    // The glow is brief and the list re-renders as the search ends; the reveal is the row in view.
    await expect(chatRow).toBeInViewport()
    await capture(page, 'bot-search-after.png')
  })

  test('Send to agent reveals a bot worker it forces into a folded Projects', async ({
    electronApp,
    orcaPage: page,
    testRepoPath
  }) => {
    const worker = await secondaryWorktree(page, testRepoPath)
    const lineage = workerLineage(worker)
    await stubBot(electronApp, { [worker.worktreeId]: CHAT_ID }, lineage)
    await openScene(page, { kind: 'worker', ...worker, lineage })
    await expect.poll(() => listedInProjects(page, worker.worktreeId)).toBe(false)
    await seedSendTarget(page, worker.worktreeId)
    await page.evaluate(() => {
      const state = window.__store!.getState()
      if (!state.collapsedGroups.has('projects-section')) {
        state.toggleCollapsedGroup('projects-section')
      }
    })
    await capture(page, 'send-to-agent-before.png')

    await page.getByRole('button', { name: 'Send notes to an agent', exact: true }).click()

    // Projects unfolds to the forced row, which shows its send target and the reveal's glow.
    const row = page.locator(
      `[data-worktree-sidebar] [role="option"][data-worktree-id=${JSON.stringify(worker.worktreeId)}]`
    )
    await expect(row).toBeVisible()
    await expect(row.locator('[data-agent-send-target="eligible"]')).toBeVisible()
    await expectRevealed(row.locator('[data-worktree-card-surface]').first())
    await capture(page, 'send-to-agent-after.png')
  })
})
