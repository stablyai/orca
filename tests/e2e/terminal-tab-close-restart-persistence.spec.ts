import { existsSync, readFileSync } from 'node:fs'
import type { ElectronApplication } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { TEST_REPO_PATH_FILE } from './global-setup'
import { waitForActiveTerminalManager, waitForPaneCount } from './helpers/terminal'
import {
  ensureTerminalVisible,
  getActiveTabId,
  getWorktreeTabs,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import { worktreeRowSurface } from './worktree-row-locators'
import { RuntimeClient } from '../../src/cli/runtime/client'
import { RuntimeRpcFailureError } from '../../src/cli/runtime/types'
import type {
  RuntimeTerminalClose,
  RuntimeTerminalListResult,
  RuntimeTerminalSplit,
  RuntimeWorktreeRecord
} from '../../src/shared/runtime-types'

test.describe.configure({ mode: 'serial' })

test('durable whole-tab close removes a split tab across restart', async (// oxlint-disable-next-line no-empty-pattern -- This lifecycle test owns both Electron launches and intentionally opts out of the default app fixture.
{}, testInfo) => {
  const repoPath = readFileSync(TEST_REPO_PATH_FILE, 'utf8').trim()
  if (!repoPath || !existsSync(repoPath)) {
    test.skip(true, 'Global setup did not produce a seeded test repo')
    return
  }

  const session = createRestartSession(testInfo)
  let firstApp: ElectronApplication | null = null
  let secondApp: ElectronApplication | null = null

  try {
    const firstLaunch = await session.launch()
    firstApp = firstLaunch.app
    const worktreeId = await attachRepoAndOpenTerminal(firstLaunch.page, repoPath)
    await waitForSessionReady(firstLaunch.page)
    await waitForActiveWorktree(firstLaunch.page)
    await ensureTerminalVisible(firstLaunch.page)

    const hasPaneManager = await waitForActiveTerminalManager(firstLaunch.page, 30_000)
      .then(() => true)
      .catch(() => false)
    test.skip(
      !hasPaneManager,
      'Electron automation in this environment never mounted the TerminalPane manager.'
    )
    await waitForPaneCount(firstLaunch.page, 1, 30_000)

    const closedTabId = await getActiveTabId(firstLaunch.page)
    if (!closedTabId) {
      throw new Error('First launch did not expose an active terminal tab')
    }
    expect(await getWorktreeTabs(firstLaunch.page, worktreeId)).toHaveLength(1)

    const client = new RuntimeClient(session.userDataDir, 30_000)
    await expect
      .poll(
        async () => {
          try {
            const shown = await client.call<{ worktree: RuntimeWorktreeRecord }>('worktree.show', {
              worktree: `id:${worktreeId}`
            })
            return shown.result.worktree.id
          } catch (error) {
            if (error instanceof RuntimeRpcFailureError && error.code === 'selector_not_found') {
              return null
            }
            throw error
          }
        },
        { message: 'Split target did not become runtime-worktree-resolvable' }
      )
      .toBe(worktreeId)
    let activeHandle: string | null = null
    await expect
      .poll(
        async () => {
          const listed = await client.call<RuntimeTerminalListResult>('terminal.list', {
            worktree: `id:${worktreeId}`
          })
          const matching = listed.result.terminals.filter(
            (terminal) => terminal.worktreeId === worktreeId && terminal.tabId === closedTabId
          )
          activeHandle = matching.length === 1 ? (matching[0]?.handle ?? null) : null
          return matching.length
        },
        { message: 'Closed-tab candidate did not become uniquely runtime-visible' }
      )
      .toBe(1)
    if (!activeHandle) {
      throw new Error('Closed-tab candidate became visible without a terminal handle')
    }
    const split = await client.call<{ split: RuntimeTerminalSplit }>('terminal.split', {
      terminal: activeHandle,
      direction: 'vertical'
    })
    expect(split.result.split.tabId).toBe(closedTabId)
    await waitForPaneCount(firstLaunch.page, 2, 30_000)

    const close = await client.call<{ close: RuntimeTerminalClose }>('terminal.closeTab', {
      terminal: split.result.split.handle
    })
    expect(close.result.close).toMatchObject({
      handle: split.result.split.handle,
      tabId: closedTabId,
      closeMode: 'tab'
    })
    await expect
      .poll(() => getWorktreeTabs(firstLaunch.page, worktreeId), {
        message: 'The acknowledged close left the split terminal tab in renderer state'
      })
      .toEqual([])

    await expect
      .poll(
        async () => {
          const afterClose = await client.call<RuntimeTerminalListResult>('terminal.list', {
            worktree: `id:${worktreeId}`
          })
          return afterClose.result.terminals
            .filter((terminal) => terminal.tabId === closedTabId)
            .map((terminal) => terminal.handle)
        },
        { message: 'The acknowledged close left host terminal rows alive' }
      )
      .toEqual([])

    await session.close(firstApp)
    firstApp = null

    const secondLaunch = await session.launch()
    secondApp = secondLaunch.app
    await waitForSessionReady(secondLaunch.page)
    const restoredWorktreeId = await attachRepoAndOpenTerminal(secondLaunch.page, repoPath)
    expect(restoredWorktreeId).toBe(worktreeId)

    // Why: wait past initial worktree effects so this checks resurrection, not
    // only the first hydrated frame before default-tab logic has run.
    await secondLaunch.page.waitForTimeout(1_000)
    const restoredTabs = await getWorktreeTabs(secondLaunch.page, worktreeId)
    expect(restoredTabs).toEqual([])

    const afterRestart = await client.call<RuntimeTerminalListResult>('terminal.list', {
      worktree: `id:${worktreeId}`
    })
    expect(afterRestart.result.terminals).toEqual([])

    // Why: the tombstone only binds passive hydration. Clicking the sidebar row is the
    // user asking for the workspace back, so explicit activation must re-seed a fresh
    // terminal instead of leaving the blank tab bar that regressed in #14590.
    await worktreeRowSurface(secondLaunch.page, worktreeId).click()
    await expect
      .poll(() => getWorktreeTabs(secondLaunch.page, worktreeId), {
        message: 'Explicit sidebar activation did not re-seed a terminal tab'
      })
      .toHaveLength(1)
    const reseededTabs = await getWorktreeTabs(secondLaunch.page, worktreeId)
    expect(reseededTabs[0]?.id).not.toBe(closedTabId)
  } finally {
    if (firstApp) {
      await session.close(firstApp)
    }
    if (secondApp) {
      await session.close(secondApp)
    }
    await session.dispose()
  }
})
