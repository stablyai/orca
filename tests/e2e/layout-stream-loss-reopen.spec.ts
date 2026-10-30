// Layout-owner stream loss/reopen must retain every tab/pane exactly once, catch up main/window changes and persist them across relaunch.

import { existsSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import { ensureTerminalVisible, switchToWorktree, waitForSessionReady } from './helpers/store'
import { splitActiveTerminalPane, waitForActiveTerminalManager } from './helpers/terminal'
import { leafIdsInOrder } from './helpers/workspace-layout-oracle-model'
import { readMainLayout, type TerminalLayout } from './helpers/main-terminal-layout'

const LAYOUT_OWNER_BUILD = existsSync(
  path.join(process.cwd(), 'out', 'main', 'ORCA_LAYOUT_OWNER_MAIN')
)

type Launched = Awaited<ReturnType<ReturnType<typeof createRestartSession>['launch']>>

/** What the window draws for the workspace's terminal tabs. */
async function readWindowLayout(page: Page, worktreeId: string): Promise<TerminalLayout> {
  const drawn = await page.evaluate((id) => {
    const state = window.__store!.getState()
    const terminalIds = new Set((state.tabsByWorktree[id] ?? []).map((tab) => tab.id))
    // Every drawn row, so a duplicate row under one id still counts twice.
    const rows = (state.tabsByWorktree[id] ?? []).map((tab) => tab.id)
    const tabBar = (state.unifiedTabsByWorktree[id] ?? [])
      .filter((entry) => entry.contentType === 'terminal' && terminalIds.has(entry.entityId))
      .map((entry) => entry.entityId)
    const roots = Object.fromEntries(
      rows.map((tabId) => [tabId, state.terminalLayoutsByTabId[tabId]?.root ?? null])
    )
    return { rows, tabBar, roots }
  }, worktreeId)
  if (drawn.rows.length !== drawn.tabBar.length) {
    // A row without its tab-bar entry, or the reverse: surfaces as a mismatch, not a pass.
    return [
      ['rows', drawn.rows],
      ['tabBar', drawn.tabBar]
    ]
  }
  return drawn.tabBar.map((tabId) => [tabId, leafIdsInOrder(drawn.roots[tabId])])
}

/** Tab ids in tab-bar order and each tab's pane count: what a lost or doubled tab or pane changes. */
type Summary = { tabs: string[]; panes: number[] }

function summarize(layout: TerminalLayout): Summary {
  return { tabs: layout.map(([tabId]) => tabId), panes: layout.map(([, panes]) => panes.length) }
}

/** Polls until the window and main both show `want` three reads in a row: a late duplicate fails. */
async function expectSettled(page: Page, worktreeId: string, want: Summary): Promise<void> {
  let streak = 0
  await expect
    .poll(
      async () => {
        const [windowLayout, mainLayout] = await Promise.all([
          readWindowLayout(page, worktreeId),
          readMainLayout(page, worktreeId)
        ])
        const shown = { window: summarize(windowLayout), main: summarize(mainLayout) }
        const match =
          JSON.stringify(windowLayout) === JSON.stringify(mainLayout) &&
          JSON.stringify(shown.window) === JSON.stringify(want)
        streak = match ? streak + 1 : 0
        return streak >= 3 ? want : { ...shown, windowLayout, mainLayout }
      },
      { timeout: 30_000, intervals: [500] }
    )
    .toEqual(want)
}

/** The tab and handle of a terminal main started itself, as the CLI's create does. */
function readCreatedTerminal(reply: unknown): { tabId: string; handle: string } {
  const result = reply && typeof reply === 'object' && 'result' in reply ? reply.result : null
  const terminal =
    result && typeof result === 'object' && 'terminal' in result ? result.terminal : null
  const tabId =
    terminal && typeof terminal === 'object' && 'tabId' in terminal ? terminal.tabId : null
  const handle =
    terminal && typeof terminal === 'object' && 'handle' in terminal ? terminal.handle : null
  if (typeof tabId !== 'string' || typeof handle !== 'string') {
    throw new Error(`terminal.create gave no tab: ${JSON.stringify(reply).slice(0, 300)}`)
  }
  return { tabId, handle }
}

/** A split main makes itself, as the CLI's split does. */
async function splitMainTerminal(page: Page, handle: string): Promise<void> {
  const reply = await page.evaluate(
    (terminal) =>
      window.api.runtime.call({
        method: 'terminal.split',
        params: { terminal, direction: 'vertical' }
      }),
    handle
  )
  if (!reply.ok) {
    throw new Error(`terminal.split failed: ${JSON.stringify(reply).slice(0, 300)}`)
  }
}

function watchStreamStops(page: Page): string[] {
  const stops: string[] = []
  page.on('console', (message) => {
    if (message.text().includes('[layout-owner] layout stream stopped')) {
      stops.push(message.text())
    }
  })
  return stops
}

function watchRefusals(page: Page, refusals: string[]): void {
  page.on('console', (message) => {
    if (/\[layout-owner\].*(refused|failed)/.test(message.text())) {
      refusals.push(message.text())
    }
  })
}

async function openWorkspace(first: Launched, repoPath: string): Promise<string> {
  await waitForSessionReady(first.page)
  const worktreeId = await attachRepoAndOpenTerminal(first.page, repoPath)
  await ensureTerminalVisible(first.page)
  await waitForActiveTerminalManager(first.page, 30_000)
  await expect
    .poll(() => first.page.evaluate(() => typeof window.__endLocalLayoutStreamE2E), {
      timeout: 15_000,
      message: 'no layout stream, or a build without --mode e2e (the end hook is e2e-mode only)'
    })
    .toBe('function')
  return worktreeId
}

// While the stream is down, create window and main terminals; after reopen, split main’s terminal.
async function loseStreamAndChange(
  page: Page,
  worktreeId: string,
  stops: string[]
): Promise<{ firstTab: string; duringLoss: string; mainTab: string }> {
  const firstTab = await page.evaluate(
    (id) => window.__store!.getState().tabsByWorktree[id]?.[0]?.id ?? '',
    worktreeId
  )
  await expectSettled(page, worktreeId, { tabs: [firstTab], panes: [1] })
  const gap = await page.evaluate(async (id) => {
    const end = window.__endLocalLayoutStreamE2E!
    await end()
    const state = window.__store!.getState()
    const tab = state.createTab(id)
    state.setActiveTab(tab.id)
    const startedAt = performance.now()
    const created = await window.api.runtime.call({
      method: 'terminal.create',
      params: { worktree: `id:${id}`, focus: false, activate: false, presentation: 'background' }
    })
    // A reopened stream's snapshot re-arms the hook with a new function.
    return {
      tabId: tab.id,
      created,
      createMs: Math.round(performance.now() - startedAt),
      beforeReopen: window.__endLocalLayoutStreamE2E === end
    }
  }, worktreeId)
  await expect.poll(() => stops.length, { message: 'the stream never stopped' }).toBe(1)
  expect(
    gap.beforeReopen,
    `main's terminal must start before the 1 s reopen (its create took ${gap.createMs} ms)`
  ).toBe(true)
  const mainTerminal = readCreatedTerminal(gap.created)
  await expectSettled(page, worktreeId, {
    tabs: [firstTab, gap.tabId, mainTerminal.tabId],
    panes: [1, 1, 1]
  })
  await splitMainTerminal(page, mainTerminal.handle)
  await expectSettled(page, worktreeId, {
    tabs: [firstTab, gap.tabId, mainTerminal.tabId],
    panes: [1, 1, 2]
  })
  return { firstTab, duringLoss: gap.tabId, mainTab: mainTerminal.tabId }
}

test.describe('the window layout stream ends mid-session', () => {
  test.skip(!LAYOUT_OWNER_BUILD, 'layout-owner build only: other builds open no layout stream')

  test('reopens with no tab or pane lost or doubled, and later changes apply', async ({
    testRepoPath
  }, testInfo) => {
    const session = createRestartSession(testInfo)
    const refusals: string[] = []
    let app: Launched['app'] | undefined
    try {
      const first = await session.launch()
      app = first.app
      const stops = watchStreamStops(first.page)
      watchRefusals(first.page, refusals)
      const worktreeId = await openWorkspace(first, testRepoPath)
      const { firstTab, duringLoss, mainTab } = await loseStreamAndChange(
        first.page,
        worktreeId,
        stops
      )

      await first.page.evaluate((tabId) => window.__store!.getState().closeTab(tabId), duringLoss)
      const afterReopen = await first.page.evaluate((id) => {
        const state = window.__store!.getState()
        const tab = state.createTab(id)
        state.setActiveTab(tab.id)
        return tab.id
      }, worktreeId)
      await waitForActiveTerminalManager(first.page, 30_000)
      await splitActiveTerminalPane(first.page, 'vertical')
      await expectSettled(first.page, worktreeId, {
        tabs: [firstTab, mainTab, afterReopen],
        panes: [1, 2, 2]
      })
      expect(stops).toHaveLength(1)
      expect(refusals).toEqual([])
    } finally {
      await session.dispose(app)
    }
  })

  test('a change made after the stream ended survives a relaunch', async ({
    testRepoPath
  }, testInfo) => {
    const session = createRestartSession(testInfo)
    const refusals: string[] = []
    let app: Launched['app'] | undefined
    try {
      const first = await session.launch()
      app = first.app
      const stops = watchStreamStops(first.page)
      watchRefusals(first.page, refusals)
      const worktreeId = await openWorkspace(first, testRepoPath)
      const { firstTab, duringLoss, mainTab } = await loseStreamAndChange(
        first.page,
        worktreeId,
        stops
      )

      await first.page.evaluate((tabId) => window.__store!.getState().closeTab(tabId), firstTab)
      await first.page.evaluate(
        (tabId) => window.__store!.getState().setActiveTab(tabId),
        duringLoss
      )
      await waitForActiveTerminalManager(first.page, 30_000)
      await splitActiveTerminalPane(first.page, 'vertical')
      const beforeQuit = { tabs: [duringLoss, mainTab], panes: [2, 2] }
      await expectSettled(first.page, worktreeId, beforeQuit)
      // Long enough for the window's debounced save to land.
      await first.page.waitForTimeout(2_000)
      await session.close(app)
      app = undefined

      const second = await session.launch()
      app = second.app
      watchRefusals(second.page, refusals)
      await waitForSessionReady(second.page)
      await switchToWorktree(second.page, worktreeId)
      await expectSettled(second.page, worktreeId, beforeQuit)
      expect(refusals).toEqual([])
    } finally {
      await session.dispose(app)
    }
  })
})
