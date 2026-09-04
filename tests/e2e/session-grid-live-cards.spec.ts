// The session grid with several live terminals: typed echo survives claim/resync, focus stays
// put across resyncs, and a manual card order survives the resize-triggered persisted-UI broadcast.

import { existsSync, readFileSync } from 'node:fs'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import { TEST_REPO_PATH_FILE } from './global-setup'

const CARD = '[data-testid="session-grid-card"]'

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
    ({ worktreeId, count }) => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is unavailable')
      }
      const state = store.getState()
      const existing = state.tabsByWorktree[worktreeId] ?? []
      const ids = existing.map((tab) => tab.id)
      for (let i = ids.length; i < count; i += 1) {
        const tab = state.createTab(worktreeId, undefined, undefined, {
          activate: false,
          id: `session-grid-e2e-${i}`
        })
        if (tab) {
          ids.push(tab.id)
        }
      }
      store.setState({ sessionsGridPreset: '2x2', sessionsGridScrollMode: 'row' })
      state.openSessionsPage()
      return ids
    },
    { worktreeId, count }
  )
}

test.describe('session grid', () => {
  test('previews every session, echoes typing in the card that has the keyboard, and keeps a manual order across a window resize and a restart', async (// oxlint-disable-next-line no-empty-pattern -- Playwright's second fixture arg is testInfo; the first must be an object destructure to opt out of the default fixture set.
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

      // Every session gets a card, and every card gets a live terminal —
      // staged one per frame, so give the last one a moment.
      await expect(page.locator(CARD)).toHaveCount(4)
      await expect(page.locator(`${CARD} .xterm`)).toHaveCount(4, { timeout: 20_000 })

      // Typing lands in the card the user clicked, and its echo shows up there.
      const target = page.locator(`${CARD}[data-tab-id="${tabIds[1]}"]`)
      await target.locator('.xterm').click()
      const marker = `grid-echo-${Date.now()}`
      await page.keyboard.type(`echo ${marker}`)
      await page.keyboard.press('Enter')
      await expect(target).toContainText(marker, { timeout: 15_000 })
      // ...and nowhere else.
      for (const other of tabIds.filter((id) => id !== tabIds[1])) {
        await expect(page.locator(`${CARD}[data-tab-id="${other}"]`)).not.toContainText(marker)
      }

      // A manual order must survive the persisted-UI broadcast a window resize
      // triggers (main persists windowBounds 500ms after every resize and
      // re-emits the whole UI state), which used to put the disk order back.
      const reversed = tabIds.toReversed()
      await page.evaluate(
        (order) => window.__store!.getState().setSessionsGridTabOrder(order),
        reversed
      )
      await expect(page.locator(CARD).first()).toHaveAttribute('data-tab-id', reversed[0]!)
      const bounds = await first.app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.getBounds()
      )
      await first.app.evaluate(
        ({ BrowserWindow }, next) => BrowserWindow.getAllWindows()[0]!.setBounds(next),
        {
          ...bounds,
          width: bounds.width - 120
        }
      )
      await page.waitForTimeout(1_500)
      await expect(page.locator(CARD).first()).toHaveAttribute('data-tab-id', reversed[0]!)

      await session.close(first.app)
      firstApp = null

      const second = await session.launch()
      secondApp = second.app
      await waitForSessionReady(second.page)
      await second.page.evaluate(() => window.__store!.getState().openSessionsPage())
      await expect(second.page.locator(CARD).first()).toHaveAttribute('data-tab-id', reversed[0]!, {
        timeout: 30_000
      })
      // Why graceful here too: a bare app.close() with four restored terminals
      // waits on the shutdown checkpoint and hung the worker at teardown.
      await session.close(second.app)
      secondApp = null
    } finally {
      await firstApp?.close().catch(() => undefined)
      await secondApp?.close().catch(() => undefined)
      await session.dispose().catch(() => undefined)
    }
  })
})
