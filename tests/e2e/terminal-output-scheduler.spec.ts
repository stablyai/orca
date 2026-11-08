// Recover hidden overflow from main-owned terminal state when the tab becomes visible.

import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import {
  ensureTerminalVisible,
  getActiveTabId,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'
import { getTerminalContent, waitForActiveTerminalManager } from './helpers/terminal'

const SORTABLE_TAB = '[data-testid="sortable-tab"]'

function tabLocator(page: Page, tabId: string) {
  return page.locator(`${SORTABLE_TAB}[data-tab-id="${tabId}"]`).first()
}

async function countRenderedTabs(page: Page): Promise<number> {
  return page.locator(SORTABLE_TAB).count()
}

async function getDomActiveTabId(page: Page): Promise<string | null> {
  return page.evaluate((selector) => {
    const match = document.querySelector(`${selector}[data-active="true"]`)
    return match?.getAttribute('data-tab-id') ?? null
  }, SORTABLE_TAB)
}

function nodeScriptCommand(script: string): string {
  return `node -e "${script}"`
}

async function createTerminalTab(page: Page): Promise<string> {
  const tabsBefore = await countRenderedTabs(page)
  const activeBefore = await getActiveTabId(page)

  const createdTabId = await page.evaluate(() => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    const state = store.getState()
    const worktreeId = state.activeWorktreeId
    if (!worktreeId) {
      throw new Error('createTerminalTab: active worktree id was unavailable')
    }
    // Create tabs through store actions to isolate mounted-PTY scheduling from menu hit-test flakes.
    return state.createTab(worktreeId).id
  })

  await expect
    .poll(() => countRenderedTabs(page), {
      timeout: 5_000,
      message: 'New Terminal did not render a new tab in the tab bar'
    })
    .toBe(tabsBefore + 1)

  let tabId: string | null = null
  await expect
    .poll(
      async () => {
        tabId = await getActiveTabId(page)
        return tabId === createdTabId && tabId !== activeBefore
      },
      {
        timeout: 5_000,
        message: 'New Terminal did not become the active tab'
      }
    )
    .toBe(true)

  if (!tabId) {
    throw new Error('createTerminalTab: active tab id was unavailable after creating terminal')
  }
  return tabId
}

async function waitForTabPtyId(page: Page, tabId: string): Promise<string> {
  let ptyId: string | null = null
  await expect
    .poll(
      async () => {
        ptyId = await page.evaluate((targetTabId) => {
          const manager = window.__paneManagers?.get(targetTabId)
          const pane = manager?.getPanes?.()[0] ?? null
          return pane?.container?.dataset?.ptyId ?? null
        }, tabId)
        return ptyId
      },
      {
        timeout: 15_000,
        message: `Terminal tab ${tabId} did not receive a PTY binding`
      }
    )
    .not.toBeNull()

  if (!ptyId) {
    throw new Error(`waitForTabPtyId: tab ${tabId} has no PTY id`)
  }
  return ptyId
}

async function sendPtyCommands(
  page: Page,
  commands: { ptyId: string; command: string }[]
): Promise<void> {
  await page.evaluate((items) => {
    for (const item of items) {
      window.api.pty.write(item.ptyId, `${item.command}\r`, 'driving')
    }
  }, commands)
}

async function mainSnapshotContains(page: Page, ptyId: string, text: string): Promise<boolean> {
  return page.evaluate(
    async ({ targetPtyId, expectedText }) => {
      const snapshot = await window.api.pty.getMainBufferSnapshot(targetPtyId, {
        scrollbackRows: 200
      })
      return snapshot?.data.includes(expectedText) ?? false
    },
    { targetPtyId: ptyId, expectedText: text }
  )
}

test.describe('Terminal output scheduler', () => {
  test('hidden overflow restores from main-owned terminal state when the tab becomes visible', async ({
    orcaPage
  }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)

    const foregroundTabId = await getActiveTabId(orcaPage)
    if (!foregroundTabId) {
      throw new Error('Expected an initial terminal tab')
    }
    const hiddenTabId = await createTerminalTab(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    const hiddenPtyId = await waitForTabPtyId(orcaPage, hiddenTabId)

    await tabLocator(orcaPage, foregroundTabId).click()
    await expect
      .poll(() => getDomActiveTabId(orcaPage), {
        timeout: 5_000,
        message: 'Foreground terminal tab did not become active before hidden flood'
      })
      .toBe(foregroundTabId)

    const marker = `HIDDEN_RECOVERY_${Date.now()}`
    const floodCommand = nodeScriptCommand(
      `for (let i = 0; i < 55000; i++) console.log('RECOVER_FILL_' + i + '_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'); console.log('${marker}')`
    )

    await sendPtyCommands(orcaPage, [{ ptyId: hiddenPtyId, command: floodCommand }])

    await expect
      .poll(async () => mainSnapshotContains(orcaPage, hiddenPtyId, marker), {
        timeout: 30_000,
        message: 'Main-owned terminal snapshot did not capture the hidden flood marker'
      })
      .toBe(true)

    await tabLocator(orcaPage, hiddenTabId).click()
    await expect
      .poll(() => getDomActiveTabId(orcaPage), {
        timeout: 5_000,
        message: 'Hidden terminal tab did not become visible for recovery verification'
      })
      .toBe(hiddenTabId)

    await expect
      .poll(async () => (await getTerminalContent(orcaPage)).includes(marker), {
        timeout: 10_000,
        message: 'Hidden terminal did not restore the marker from main-owned state'
      })
      .toBe(true)

    expect(await getTerminalContent(orcaPage)).not.toContain('Orca skipped hidden terminal output')
  })
})
