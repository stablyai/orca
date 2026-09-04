// Attention in the real app: a session that finished two rows below the fold raises a pill, the
// pill scrolls to it, and clicking the card puts the notice out in the shared maps the sidebar,
// the tab bar, the Dock badge and Activity all read.
//
// Why this needs the real app and not the unit tests next to the components: those mount the ack
// loop by hand, so nothing there would notice if `useAppShellServices` stopped mounting it. Here
// the only thing driving the ack is the app itself.
//
// The app is driven in Spanish on purpose and every locator is a test id or a data attribute: an
// English `has-text` would pass vacuously under any other locale.

import { existsSync, readFileSync } from 'node:fs'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import { TEST_REPO_PATH_FILE } from './global-setup'

const CARD = '[data-testid="session-grid-card"]'
const BADGE = '[data-attention-badge]'
const PILL = '[data-testid="session-grid-offscreen-attention"]'
const SCROLL_CONTAINER = '#session-grid-scroll-container'

function seededRepoPathOrSkip(): string {
  const repoPath = existsSync(TEST_REPO_PATH_FILE)
    ? readFileSync(TEST_REPO_PATH_FILE, 'utf-8').trim()
    : ''
  test.skip(!repoPath || !existsSync(repoPath), 'Global setup did not produce a seeded test repo')
  return repoPath
}

/** Six sessions in a 2x2 grid: rows 0-1 on screen, the last two cards below the fold. */
async function openGridWithSessions(
  page: Page,
  worktreeId: string,
  count: number
): Promise<string[]> {
  return page.evaluate(
    async ({ worktreeId, count }) => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is unavailable')
      }
      const state = store.getState()
      const ids = (state.tabsByWorktree[worktreeId] ?? []).map((tab) => tab.id)
      for (let i = ids.length; i < count; i += 1) {
        const tab = state.createTab(worktreeId, undefined, undefined, {
          activate: false,
          id: `session-grid-attention-e2e-${i}`
        })
        if (tab) {
          ids.push(tab.id)
        }
      }
      // I18nProvider applies this to i18next; the rest of the test runs translated.
      await state.updateSettings({ uiLanguage: 'es' })
      store.setState({
        sessionsGridPreset: '2x2',
        sessionsGridScrollMode: 'row',
        sessionsGridShowEmpty: false
      })
      state.openSessionsPage()
      return ids
    },
    { worktreeId, count }
  )
}

function markUnread(page: Page, tabId: string): Promise<{ paneKey: string | null }> {
  return page.evaluate((tabId) => {
    const state = window.__store!.getState()
    state.markTerminalTabUnread(tabId)
    const leafId = state.terminalLayoutsByTabId[tabId]?.activeLeafId ?? null
    const paneKey = leafId ? `${tabId}:${leafId}` : null
    if (paneKey) {
      state.markAgentCompletionPaneUnread(paneKey)
    }
    return { paneKey }
  }, tabId)
}

function readAttention(
  page: Page,
  tabId: string,
  paneKey: string
): Promise<{ tabUnread: boolean; paneUnread: boolean }> {
  return page.evaluate(
    ({ tabId, paneKey }) => {
      const state = window.__store!.getState()
      return {
        tabUnread: state.unreadTerminalTabs[tabId] === true,
        paneUnread: state.unreadAgentCompletionPanes[paneKey] === true
      }
    },
    { tabId, paneKey }
  )
}

test.describe('session grid attention', () => {
  test('raises a pill for an offscreen turn, scrolls to it, and puts its notice out on click', async (// oxlint-disable-next-line no-empty-pattern -- Playwright's second fixture arg is testInfo; the first must be an object destructure to opt out of the default fixture set.
  {}, testInfo) => {
    test.setTimeout(300_000)
    const repoPath = seededRepoPathOrSkip()
    const session = createRestartSession(testInfo)
    let app: ElectronApplication | null = null
    try {
      const launched = await session.launch()
      app = launched.app
      const page = launched.page
      await waitForSessionReady(page)
      const worktreeId = await attachRepoAndOpenTerminal(page, repoPath)

      const tabIds = await openGridWithSessions(page, worktreeId, 6)
      expect(tabIds).toHaveLength(6)
      await expect(page.locator(CARD)).toHaveCount(6)
      await expect(page.locator(`${CARD} .xterm`)).toHaveCount(6, { timeout: 30_000 })

      // Nothing is asking for anything yet.
      await expect(page.locator(PILL)).toHaveCount(0)

      // The last card is on row 2, two rows below a 2-row viewport.
      const offscreenTabId = tabIds[5]!
      const { paneKey } = await markUnread(page, offscreenTabId)
      expect(paneKey, 'the offscreen card should have a live pane to mark').not.toBeNull()

      // The card wears the bell...
      await expect(
        page.locator(`${CARD}[data-tab-id="${offscreenTabId}"] ${BADGE}`)
      ).toHaveAttribute('data-attention-badge', 'unread')
      // ...and, because it is out of view, the grid says so at the bottom edge.
      const pill = page.locator(`${PILL}[data-direction="below"]`)
      await expect(pill).toHaveCount(1)
      await expect(page.locator(`${PILL}[data-direction="above"]`)).toHaveCount(0)

      const scrollTopBefore = await page.locator(SCROLL_CONTAINER).evaluate((el) => el.scrollTop)
      expect(scrollTopBefore).toBe(0)

      await pill.click()

      // The pill goes when the card it pointed at is on screen, and the grid actually moved.
      await expect(page.locator(PILL)).toHaveCount(0)
      await expect
        .poll(() => page.locator(SCROLL_CONTAINER).evaluate((el) => el.scrollTop), {
          timeout: 15_000
        })
        .toBeGreaterThan(0)

      // The window has to be focused for a sighting to count; otherwise the ack loop
      // deliberately refuses to clear anything.
      expect(await page.evaluate(() => document.hasFocus())).toBe(true)

      expect(await readAttention(page, offscreenTabId, paneKey!)).toEqual({
        tabUnread: true,
        paneUnread: true
      })

      await page.locator(`${CARD}[data-tab-id="${offscreenTabId}"]`).click()

      // One click, and the notice is out in the maps the sidebar, the tab bar, the Dock
      // badge and Activity all read — not just in the grid's own glyph.
      // Bounded on purpose: the ack is synchronous on the click, so a regression here should
      // read as a failure in seconds, not as a test that runs out the clock.
      await expect
        .poll(() => readAttention(page, offscreenTabId, paneKey!), { timeout: 15_000 })
        .toEqual({ tabUnread: false, paneUnread: false })
      await expect(
        page.locator(`${CARD}[data-tab-id="${offscreenTabId}"] ${BADGE}`)
      ).toHaveAttribute('data-attention-badge', 'none')

      await session.close(launched.app)
      app = null
    } finally {
      await app?.close().catch(() => undefined)
      await session.dispose().catch(() => undefined)
    }
  })
})
