/**
 * E2E repro for terminal output bursts from many background tabs.
 *
 * This is a scaled-down version of the user report: several terminal tabs are
 * mounted, inactive tabs emit large output bursts, and the focused tab must
 * still render a foreground marker while the background output drains through
 * the shared scheduler instead of direct xterm writes.
 */

import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import {
  ensureTerminalVisible,
  getActiveTabId,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'
import { getTerminalContent, waitForActiveTerminalManager } from './helpers/terminal'

type SchedulerDebugSnapshot = {
  backgroundEnqueueCount: number
  foregroundWriteCount: number
  backgroundWriteCount: number
  flushWriteCount: number
  scheduledDrainCount: number
  drainWrites: number[]
}

type SchedulerDebugWindow = Window & {
  __terminalOutputSchedulerDebug?: {
    reset: () => void
    snapshot: () => SchedulerDebugSnapshot
  }
}

const SORTABLE_TAB = '[data-testid="sortable-tab"]'
const TAB_COUNT = 5

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

function nodeConsoleCommand(expression: string): string {
  return `node -e "console.log(${expression})"`
}

async function createTerminalTab(page: Page): Promise<string> {
  const tabsBefore = await countRenderedTabs(page)
  const activeBefore = await getActiveTabId(page)

  await page.getByRole('button', { name: 'New tab' }).click()
  await page
    .getByRole('menuitem', { name: /New Terminal/i })
    .first()
    .click()

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
        return Boolean(tabId && tabId !== activeBefore)
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

async function resetSchedulerDebug(page: Page): Promise<void> {
  await page.evaluate(() => {
    const debug = (window as SchedulerDebugWindow).__terminalOutputSchedulerDebug
    if (!debug) {
      throw new Error('terminal output scheduler debug API is unavailable')
    }
    debug.reset()
  })
}

async function getSchedulerDebug(page: Page): Promise<SchedulerDebugSnapshot> {
  return page.evaluate(() => {
    const debug = (window as SchedulerDebugWindow).__terminalOutputSchedulerDebug
    if (!debug) {
      throw new Error('terminal output scheduler debug API is unavailable')
    }
    return debug.snapshot()
  })
}

async function sendPtyCommands(
  page: Page,
  commands: { ptyId: string; command: string }[]
): Promise<void> {
  await page.evaluate((items) => {
    for (const item of items) {
      window.api.pty.write(item.ptyId, `${item.command}\r`)
    }
  }, commands)
}

test.describe('Terminal output scheduler', () => {
  test('background tab output bursts use the shared drain while the active tab renders', async ({
    orcaPage
  }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)

    const firstTabId = await getActiveTabId(orcaPage)
    if (!firstTabId) {
      throw new Error('Expected an initial terminal tab')
    }

    const tabIds = [firstTabId]
    const ptyIdsByTabId: Record<string, string> = {
      [firstTabId]: await waitForTabPtyId(orcaPage, firstTabId)
    }

    while (tabIds.length < TAB_COUNT) {
      const tabId = await createTerminalTab(orcaPage)
      await waitForActiveTerminalManager(orcaPage, 30_000)
      tabIds.push(tabId)
      ptyIdsByTabId[tabId] = await waitForTabPtyId(orcaPage, tabId)
    }

    await tabLocator(orcaPage, firstTabId).click()
    await expect
      .poll(() => getDomActiveTabId(orcaPage), {
        timeout: 5_000,
        message: 'First terminal tab did not become active before the burst repro'
      })
      .toBe(firstTabId)

    await resetSchedulerDebug(orcaPage)

    const runId = Date.now()
    const foregroundMarker = `FG_SCHED_${runId}`
    // Why: the marker is appended AFTER the burst payload so it survives
    // getTerminalContent's tail-only truncation (charLimit defaults to 4000).
    // A leading marker would be evicted by the 50000-char x-burst.
    const backgroundCommands = tabIds.slice(1).map((tabId, index) => ({
      ptyId: ptyIdsByTabId[tabId],
      marker: `BG_SCHED_${runId}_${index}`,
      command: nodeConsoleCommand(`'x'.repeat(50000) + ':BG_SCHED_${runId}_${index}'`)
    }))

    await sendPtyCommands(
      orcaPage,
      backgroundCommands.map(({ ptyId, command }) => ({ ptyId, command }))
    )
    await sendPtyCommands(orcaPage, [
      {
        ptyId: ptyIdsByTabId[firstTabId],
        command: nodeConsoleCommand(`'${foregroundMarker}'`)
      }
    ])

    await expect
      .poll(async () => (await getTerminalContent(orcaPage)).includes(foregroundMarker), {
        timeout: 5_000,
        message: 'Active terminal did not render foreground output during background bursts'
      })
      .toBe(true)

    await expect
      .poll(async () => (await getSchedulerDebug(orcaPage)).backgroundEnqueueCount, {
        timeout: 5_000,
        message: 'Background PTY output did not enter the scheduler queue'
      })
      .toBeGreaterThanOrEqual(backgroundCommands.length)

    await expect
      .poll(async () => (await getSchedulerDebug(orcaPage)).backgroundWriteCount, {
        timeout: 10_000,
        message: 'Queued background PTY output did not drain into xterm'
      })
      .toBeGreaterThanOrEqual(backgroundCommands.length)

    const debug = await getSchedulerDebug(orcaPage)
    expect(debug.foregroundWriteCount).toBeGreaterThan(0)
    if (debug.drainWrites.length > 0) {
      expect(Math.max(...debug.drainWrites)).toBeLessThanOrEqual(2)
    }

    const firstBackground = backgroundCommands[0]
    const firstBackgroundTabId = tabIds[1]
    await tabLocator(orcaPage, firstBackgroundTabId).click()
    await expect
      .poll(() => getDomActiveTabId(orcaPage), {
        timeout: 5_000,
        message: 'Background terminal tab did not become active for content verification'
      })
      .toBe(firstBackgroundTabId)
    await expect
      .poll(async () => (await getTerminalContent(orcaPage)).includes(firstBackground.marker), {
        timeout: 5_000,
        message: 'Background terminal output was not preserved after scheduler drain'
      })
      .toBe(true)
  })
})
