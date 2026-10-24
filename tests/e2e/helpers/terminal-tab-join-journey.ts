/** Shared steps of the "join a single-pane tab into another tab" journeys (tab menu and drag). */

import { existsSync, readFileSync } from 'node:fs'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { expect } from './orca-app'
import { attachRepoAndOpenTerminal, type RestartSession } from './orca-restart'
import { ensureTerminalVisible, getActiveTabId, waitForSessionReady } from './store'
import { createTerminalTabFromMenu, SORTABLE_TAB } from './terminal-tab-menu'
import { waitForActivePanePtyId, waitForActiveTerminalManager } from './terminal'
import { readLeafPane, readLeafShellPid } from './terminal-leaf-pane-probes'
import { TEST_REPO_PATH_FILE } from '../global-setup'

export type TabJoinSetup = {
  targetTabId: string
  targetLeafId: string
  sourceTabId: string
  leafId: string
  ptyId: string
  pidBefore: number
}

export function seededRepoPath(): string {
  const repoPath = existsSync(TEST_REPO_PATH_FILE)
    ? readFileSync(TEST_REPO_PATH_FILE, 'utf8').trim()
    : ''
  if (!repoPath || !existsSync(repoPath)) {
    throw new Error('Tab join E2E requires the seeded test repo from global setup')
  }
  return repoPath
}

async function readSingleLeafId(page: Page, tabId: string): Promise<string> {
  return page.evaluate((tabId) => {
    const root = window.__store?.getState().terminalLayoutsByTabId[tabId]?.root
    return root?.type === 'leaf' ? root.leafId : ''
  }, tabId)
}

async function singleLeafId(page: Page, tabId: string): Promise<string> {
  await expect
    .poll(() => readSingleLeafId(page, tabId), {
      timeout: 20_000,
      message: 'Source tab never reported a single-leaf layout'
    })
    .not.toBe('')
  return readSingleLeafId(page, tabId)
}

/** Main commits a move only for a leaf it already holds, which it learns when the pane's PTY binds. */
async function waitForMainToHold(page: Page, tabIds: string[]): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(async (tabIds) => {
          const session = await window.api.session.get()
          return tabIds.every((tabId) => Boolean(session.terminalLayoutsByTabId?.[tabId]))
        }, tabIds),
      { timeout: 30_000, message: 'Main never recorded both tab layouts' }
    )
    .toBe(true)
}

export async function tabTitle(page: Page, tabId: string): Promise<string> {
  return page.evaluate((tabId) => {
    const tab = Object.values(window.__store?.getState().tabsByWorktree ?? {})
      .flat()
      .find((candidate) => candidate.id === tabId)
    return tab ? (tab.customTitle ?? tab.title) : ''
  }, tabId)
}

/** A target tab T (the first terminal) and a source tab S (a new terminal), each with one bound pane. */
export async function openTargetAndSourceTabs(page: Page, repoPath: string): Promise<TabJoinSetup> {
  await waitForSessionReady(page)
  await attachRepoAndOpenTerminal(page, repoPath)
  await ensureTerminalVisible(page)
  await waitForActiveTerminalManager(page, 30_000)
  await waitForActivePanePtyId(page, 30_000)
  const targetTabId = await getActiveTabId(page)
  if (!targetTabId) {
    throw new Error('Target tab id was unavailable')
  }
  const targetLeafId = await singleLeafId(page, targetTabId)
  const sourceTabId = await createTerminalTabFromMenu(page)
  await waitForActiveTerminalManager(page, 30_000)
  const ptyId = await waitForActivePanePtyId(page, 30_000)
  const leafId = await singleLeafId(page, sourceTabId)
  const pidBefore = await readLeafShellPid(page, {
    tabId: sourceTabId,
    leafId,
    ptyId,
    label: 'BEFORE'
  })
  await waitForMainToHold(page, [sourceTabId, targetTabId])
  return { targetTabId, targetLeafId, sourceTabId, leafId, ptyId, pidBefore }
}

async function expectJoinedState(page: Page, setup: TabJoinSetup): Promise<void> {
  const { sourceTabId, targetTabId, leafId, ptyId } = setup
  await expect(page.locator(`${SORTABLE_TAB}[data-tab-id="${sourceTabId}"]`)).toHaveCount(0)
  await expect
    .poll(
      () =>
        page.evaluate(
          ({ sourceTabId, targetTabId, leafId }) => {
            const state = window.__store?.getState()
            const hasSource = Object.values(state?.tabsByWorktree ?? {})
              .flat()
              .some((tab) => tab.id === sourceTabId)
            const target = state?.terminalLayoutsByTabId[targetTabId]
            return {
              hasSource,
              hasSourceLayout: Boolean(state?.terminalLayoutsByTabId[sourceTabId]),
              targetPty: target?.ptyIdsByLeafId?.[leafId] ?? null,
              targetLeaves: Object.keys(target?.ptyIdsByLeafId ?? {}).length
            }
          },
          { sourceTabId, targetTabId, leafId }
        ),
      { timeout: 20_000, message: 'Store never showed the moved pane inside the target tab' }
    )
    .toEqual({ hasSource: false, hasSourceLayout: false, targetPty: ptyId, targetLeaves: 2 })
}

/**
 * After a join: S is gone, T holds the pane with the same PTY and shell pid, and two relaunches
 * restore exactly that. `trackApp` keeps the caller's cleanup pointed at the live app.
 */
export async function expectJoinedAndRestored(args: {
  session: RestartSession
  page: Page
  app: ElectronApplication
  setup: TabJoinSetup
  trackApp: (app: ElectronApplication | null) => void
}): Promise<void> {
  const { session, page, setup, trackApp } = args
  const { sourceTabId, targetTabId, leafId, ptyId, pidBefore } = setup
  await expectJoinedState(page, setup)
  await expect(page.locator(`${SORTABLE_TAB}[data-tab-id="${targetTabId}"]`)).toBeVisible()
  await expect
    .poll(async () => (await readLeafPane(page, targetTabId, leafId)).ptyId, {
      timeout: 20_000,
      message: 'The moved pane never mounted inside the target tab with its PTY'
    })
    .toBe(ptyId)
  const pidAfterMove = await readLeafShellPid(page, {
    tabId: targetTabId,
    leafId,
    ptyId,
    label: 'MOVED'
  })
  expect(pidAfterMove).toBe(pidBefore)

  let app = args.app
  for (const launchNumber of [1, 2]) {
    await session.close(app)
    trackApp(null)
    const relaunched = await session.launch()
    app = relaunched.app
    trackApp(app)
    const next = relaunched.page
    await waitForSessionReady(next)
    await expect(next.locator(`${SORTABLE_TAB}[data-tab-id="${sourceTabId}"]`)).toHaveCount(0, {
      timeout: 30_000
    })
    const targetTab = next.locator(`${SORTABLE_TAB}[data-tab-id="${targetTabId}"]`)
    await expect(targetTab).toBeVisible({ timeout: 30_000 })
    await targetTab.click({ force: true })
    await waitForActiveTerminalManager(next, 30_000)
    await expect
      .poll(async () => (await readLeafPane(next, targetTabId, leafId)).ptyId, {
        timeout: 30_000,
        message: `Relaunch ${launchNumber}: the moved pane did not reattach its PTY`
      })
      .toBe(ptyId)
    expect((await readLeafPane(next, targetTabId, leafId)).mountedLeafIds).toHaveLength(2)
    const pid = await readLeafShellPid(next, {
      tabId: targetTabId,
      leafId,
      ptyId,
      label: `RELAUNCH${launchNumber}`
    })
    expect(pid).toBe(pidBefore)
  }
}
