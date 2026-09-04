// Hiding a session in the real app: the card leaves the grid, the view menu counts what is
// hidden and reveals it dimmed, and none of it is undone by the persisted-UI broadcast a window
// resize triggers (the E-16 class of failure) or by a restart.
//
// The app is driven in Spanish on purpose and every locator is a test id or a data attribute, so
// nothing here can quietly start depending on English copy — a `has-text` assertion in English
// would pass vacuously under any other locale.

import { existsSync, readFileSync } from 'node:fs'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import { TEST_REPO_PATH_FILE } from './global-setup'

const CARD = '[data-testid="session-grid-card"]'
const HIDE_BUTTON = '[data-testid="session-grid-card-hide"]'
const VIEW_MENU = '[data-testid="session-grid-view-menu"]'
const REVEAL_HIDDEN = '[data-testid="session-grid-reveal-hidden"]'
const STATE_CHIP = '[data-testid="session-grid-state-chip"]'
const EMPTY_STATE = '[data-testid="session-grid-empty-state"]'
const CLEAR_FILTERS = '[data-testid="session-grid-empty-clear-filters"]'
const REVEAL_FROM_EMPTY = '[data-testid="session-grid-empty-reveal-hidden"]'

/** The reveal switch lives in the view menu; open it, act, and let Escape put the menu away. */
async function toggleRevealHidden(page: Page): Promise<void> {
  await page.locator(VIEW_MENU).click()
  await page.locator(REVEAL_HIDDEN).click()
  await page.keyboard.press('Escape')
}

/** What the view menu says is hidden, read off the switch and closed again. */
async function readHiddenCountFromMenu(page: Page): Promise<string | null> {
  await page.locator(VIEW_MENU).click()
  const count = await page.locator(REVEAL_HIDDEN).getAttribute('data-count')
  await page.keyboard.press('Escape')
  return count
}

function seededRepoPathOrSkip(): string {
  const repoPath = existsSync(TEST_REPO_PATH_FILE)
    ? readFileSync(TEST_REPO_PATH_FILE, 'utf-8').trim()
    : ''
  test.skip(!repoPath || !existsSync(repoPath), 'Global setup did not produce a seeded test repo')
  return repoPath
}

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
          id: `session-grid-hide-e2e-${i}`
        })
        if (tab) {
          ids.push(tab.id)
        }
      }
      // I18nProvider applies this to i18next; the rest of the test runs translated.
      await state.updateSettings({ uiLanguage: 'es' })
      store.setState({ sessionsGridPreset: '2x2', sessionsGridScrollMode: 'row' })
      state.openSessionsPage()
      return ids
    },
    { worktreeId, count }
  )
}

function readHiddenTabIds(page: Page): Promise<string[]> {
  return page.evaluate(() => window.__store!.getState().sessionsGridHiddenTabIds)
}

test.describe('session grid hide and reveal', () => {
  test('hides cards, reveals them dimmed, and survives a resize and a restart', async (// oxlint-disable-next-line no-empty-pattern -- Playwright's second fixture arg is testInfo; the first must be an object destructure to opt out of the default fixture set.
  {}, testInfo) => {
    test.setTimeout(300_000)
    const repoPath = seededRepoPathOrSkip()
    const session = createRestartSession(testInfo)
    let firstApp: ElectronApplication | null = null
    let secondApp: ElectronApplication | null = null
    try {
      const first = await session.launch()
      firstApp = first.app
      const page = first.page
      await waitForSessionReady(page)
      const worktreeId = await attachRepoAndOpenTerminal(page, repoPath)

      const tabIds = await openGridWithSessions(page, worktreeId, 4)
      expect(tabIds).toHaveLength(4)
      await expect(page.locator(CARD)).toHaveCount(4)
      expect(await readHiddenCountFromMenu(page)).toBe('0')

      // Two cards out of the grid, from their own headers.
      for (const tabId of [tabIds[0]!, tabIds[2]!]) {
        await page.locator(`${CARD}[data-tab-id="${tabId}"] ${HIDE_BUTTON}`).click()
      }
      await expect(page.locator(CARD)).toHaveCount(2)
      expect(await readHiddenTabIds(page)).toEqual([tabIds[0], tabIds[2]])
      expect(await readHiddenCountFromMenu(page)).toBe('2')

      // The state axis reduces the same list: these are bare shells, so nothing is working.
      await page.locator(`${STATE_CHIP}[data-value="working"]`).click()
      await expect(page.locator(CARD)).toHaveCount(0)
      // Zero cards is three different situations, and this one is not "no sessions": four are
      // open, two of them on the grid. The screen has to say so and offer the way back —
      // `data-reason`, not the copy, because the app is running in Spanish here.
      await expect(page.locator(EMPTY_STATE)).toHaveAttribute('data-reason', 'filtered')
      await page.locator(CLEAR_FILTERS).click()
      await expect(page.locator(CARD)).toHaveCount(2)
      await expect(page.locator(EMPTY_STATE)).toHaveCount(0)

      // And with every remaining card hidden, the answer is the reveal, not a new session.
      for (const tabId of [tabIds[1]!, tabIds[3]!]) {
        await page.locator(`${CARD}[data-tab-id="${tabId}"] ${HIDE_BUTTON}`).click()
      }
      await expect(page.locator(CARD)).toHaveCount(0)
      await expect(page.locator(EMPTY_STATE)).toHaveAttribute('data-reason', 'hidden')
      await page.locator(REVEAL_FROM_EMPTY).click()
      await expect(page.locator(CARD)).toHaveCount(4)
      // Put the two back where the rest of this test expects them.
      for (const tabId of [tabIds[1]!, tabIds[3]!]) {
        await page.locator(`${CARD}[data-tab-id="${tabId}"] ${HIDE_BUTTON}`).click()
      }
      await toggleRevealHidden(page)
      await expect(page.locator(CARD)).toHaveCount(2)

      // Revealing brings them back in their own places, marked as hidden.
      await toggleRevealHidden(page)
      await expect(page.locator(CARD)).toHaveCount(4)
      await expect(page.locator(`${CARD}[data-hidden-from-grid="true"]`)).toHaveCount(2)
      await expect(page.locator(`${CARD}`).first()).toHaveAttribute('data-tab-id', tabIds[0]!)

      // Show one of them again while still revealing.
      await page.locator(`${CARD}[data-tab-id="${tabIds[0]}"] ${HIDE_BUTTON}`).click()
      await expect(page.locator(`${CARD}[data-hidden-from-grid="true"]`)).toHaveCount(1)
      expect(await readHiddenTabIds(page)).toEqual([tabIds[2]])

      // Main persists windowBounds 500 ms after a resize and re-emits the whole UI
      // state; that broadcast used to put the disk copy back over local edits.
      const bounds = await first.app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.getBounds()
      )
      await first.app.evaluate(
        ({ BrowserWindow }, next) => BrowserWindow.getAllWindows()[0]!.setBounds(next),
        { ...bounds, width: bounds.width - 120 }
      )
      await page.waitForTimeout(1_500)
      expect(await readHiddenTabIds(page)).toEqual([tabIds[2]])
      await expect(page.locator(`${CARD}[data-hidden-from-grid="true"]`)).toHaveCount(1)

      await session.close(first.app)
      firstApp = null

      // A restart restores what was hidden — and drops the reveal mode, which is
      // deliberately local state, so the hidden card comes back genuinely absent.
      const second = await session.launch()
      secondApp = second.app
      await waitForSessionReady(second.page)
      await second.page.evaluate(() => window.__store!.getState().openSessionsPage())
      await expect(second.page.locator(CARD)).toHaveCount(3, { timeout: 30_000 })
      expect(await readHiddenTabIds(second.page)).toEqual([tabIds[2]])
      await expect(second.page.locator(`${CARD}[data-tab-id="${tabIds[2]}"]`)).toHaveCount(0)
      expect(await readHiddenCountFromMenu(second.page)).toBe('1')

      await session.close(second.app)
      secondApp = null
    } finally {
      await firstApp?.close().catch(() => undefined)
      await secondApp?.close().catch(() => undefined)
      await session.dispose().catch(() => undefined)
    }
  })
})
