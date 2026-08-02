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
  deferredForegroundEnqueueCount: number
  foregroundWriteCount: number
  backgroundWriteCount: number
  deferredForegroundWriteCount: number
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
    // Why: this scheduler spec cares about mounted PTYs, not the tab menu.
    // Store creation avoids hiding xterm regressions behind menu hit-testing flakes.
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
      .poll(
        async () => {
          const debug = await getSchedulerDebug(orcaPage)
          if (debug.backgroundEnqueueCount >= backgroundCommands.length) {
            return true
          }
          const snapshots = await Promise.all(
            backgroundCommands.map(({ ptyId, marker }) =>
              mainSnapshotContains(orcaPage, ptyId, marker)
            )
          )
          return snapshots.every(Boolean)
        },
        {
          timeout: 30_000,
          message: 'Background PTY output was not retained by the scheduler or main snapshot'
        }
      )
      .toBe(true)

    await expect
      .poll(
        async () => {
          const debug = await getSchedulerDebug(orcaPage)
          return debug.backgroundEnqueueCount > 0
            ? debug.backgroundWriteCount >= backgroundCommands.length
            : true
        },
        {
          timeout: 10_000,
          message: 'Queued background terminal output did not drain through the scheduler'
        }
      )
      .toBe(true)

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

  test('visible bulk output uses the high-priority drain instead of synchronous xterm writes', async ({
    orcaPage
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)

    const activeTabId = await createTerminalTab(orcaPage)
    if (!activeTabId) {
      throw new Error('Expected a fresh terminal tab')
    }
    const ptyId = await waitForTabPtyId(orcaPage, activeTabId)
    await resetSchedulerDebug(orcaPage)

    const runId = Date.now()
    const marker = `VISIBLE_THROUGHPUT_${runId}`
    const floodCommand = nodeScriptCommand(
      `const marker='VISIBLE' + '_THROUGHPUT_' + '${runId}'; process.stdout.write('VISIBLE_FILL_${runId}\\n' + 'x'.repeat(700000) + '\\n' + marker + '\\n')`
    )

    await sendPtyCommands(orcaPage, [{ ptyId, command: floodCommand }])

    await expect
      .poll(async () => (await getTerminalContent(orcaPage, 12_000)).includes(marker), {
        timeout: 30_000,
        message: 'Active terminal did not render the visible throughput marker'
      })
      .toBe(true)

    const debug = await getSchedulerDebug(orcaPage)
    await testInfo.attach('terminal-visible-throughput-proof', {
      body: JSON.stringify(debug, null, 2),
      contentType: 'application/json'
    })
    testInfo.annotations.push({
      type: 'terminal-visible-throughput',
      description: `foreground=${debug.foregroundWriteCount} deferredForegroundEnqueue=${debug.deferredForegroundEnqueueCount} deferredForegroundWrite=${debug.deferredForegroundWriteCount} drains=${debug.drainWrites.join(',')}`
    })
    expect(debug.deferredForegroundEnqueueCount).toBeGreaterThan(0)
    expect(debug.deferredForegroundWriteCount).toBeGreaterThan(0)
  })

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
