/**
 * A terminal the CLI starts in a worktree the window never opened shows as that one tab on the
 * first visit, and again after a relaunch: no empty workspace, no second "Terminal 1" beside it
 * (layout-owner build only; main holds the tab before the window ever draws the workspace).
 */

import { existsSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import { switchToWorktree, waitForSessionReady } from './helpers/store'

const LAYOUT_OWNER_BUILD = existsSync(
  path.join(process.cwd(), 'out', 'main', 'ORCA_LAYOUT_OWNER_MAIN')
)

type Tabs = { window: string[]; storedRows: string[]; storedTabBar: string[] }

async function createWorktree(page: Page, name: string): Promise<string> {
  return page.evaluate(async (worktreeName) => {
    const state = window.__store!.getState()
    const repoId = state.allWorktrees()[0]?.repoId
    if (!repoId) {
      throw new Error('seed repo was not loaded')
    }
    return (await state.createWorktree(repoId, worktreeName, undefined, 'skip')).worktree.id
  }, name)
}

function createdTabId(reply: unknown): string | undefined {
  const result = reply && typeof reply === 'object' && 'result' in reply ? reply.result : null
  const terminal =
    result && typeof result === 'object' && 'terminal' in result ? result.terminal : null
  const tabId =
    terminal && typeof terminal === 'object' && 'tabId' in terminal ? terminal.tabId : null
  return typeof tabId === 'string' ? tabId : undefined
}

/** The CLI's create: the runtime's `terminal.create`, in the background as a worker's would be. */
async function createCliTerminal(page: Page, worktreeId: string): Promise<string> {
  const reply = await page.evaluate(
    (id) =>
      window.api.runtime.call({
        method: 'terminal.create',
        params: {
          worktree: `id:${id}`,
          command: 'sleep 600',
          focus: false,
          activate: false,
          presentation: 'background'
        }
      }),
    worktreeId
  )
  const tabId = createdTabId(reply)
  if (!tabId) {
    throw new Error(`terminal.create gave no tab: ${JSON.stringify(reply).slice(0, 300)}`)
  }
  return tabId
}

async function readTabs(page: Page, worktreeId: string): Promise<Tabs> {
  return page.evaluate(async (id) => {
    const session = await window.api.session.get()
    return {
      window: (window.__store!.getState().tabsByWorktree[id] ?? []).map((tab) => tab.id),
      storedRows: (session.tabsByWorktree?.[id] ?? []).map((row) => row.id),
      storedTabBar: (session.unifiedTabs?.[id] ?? [])
        .filter((entry) => entry.contentType === 'terminal')
        .map((entry) => entry.entityId)
    }
  }, worktreeId)
}

/** Polls until the tabs read `expected` on three reads in a row: a late duplicate fails it. */
async function expectSettledTabs(page: Page, worktreeId: string, expected: Tabs): Promise<void> {
  let streak = 0
  await expect
    .poll(
      async () => {
        const tabs = await readTabs(page, worktreeId)
        streak = JSON.stringify(tabs) === JSON.stringify(expected) ? streak + 1 : 0
        return streak >= 3 ? tabs : { ...tabs, streak }
      },
      { timeout: 30_000, intervals: [500] }
    )
    .toEqual(expected)
}

test('a CLI-started terminal in a never-opened worktree shows as its one tab, before and after a relaunch', async ({
  testRepoPath
}, testInfo) => {
  test.skip(!LAYOUT_OWNER_BUILD, 'layout-owner build only')
  const session = createRestartSession(testInfo)
  let app: Awaited<ReturnType<typeof session.launch>>['app'] | undefined
  try {
    const first = await session.launch()
    app = first.app
    await waitForSessionReady(first.page)
    await attachRepoAndOpenTerminal(first.page, testRepoPath)
    const worktreeId = await createWorktree(first.page, `cli-first-${Date.now()}`)
    const cliTabId = await createCliTerminal(first.page, worktreeId)
    const one: Tabs = { window: [cliTabId], storedRows: [cliTabId], storedTabBar: [cliTabId] }
    // Main holds it before the window has ever drawn the workspace.
    await expect
      .poll(async () => (await readTabs(first.page, worktreeId)).storedRows, { timeout: 15_000 })
      .toEqual([cliTabId])
    expect((await readTabs(first.page, worktreeId)).window).toEqual([])

    await switchToWorktree(first.page, worktreeId)
    await expectSettledTabs(first.page, worktreeId, one)
    await session.close(app)
    app = undefined

    const second = await session.launch()
    app = second.app
    await waitForSessionReady(second.page)
    await switchToWorktree(second.page, worktreeId)
    await expectSettledTabs(second.page, worktreeId, one)
  } finally {
    await session.dispose(app)
  }
})
