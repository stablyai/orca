/** Regression fixtures for manual split rendering, switching and WebGL recovery. */
import { expect } from '@playwright/test'
import type { getActiveWorktreeId } from './store'
import { splitActiveTerminalPane, waitForActiveTerminalManager } from './terminal'

type TestPage = Parameters<typeof getActiveWorktreeId>[0]

export async function createAndActivateWorktreeWithManualSplit(
  page: TestPage,
  suffix: string,
  direction: 'vertical' | 'horizontal'
): Promise<string> {
  const name = `e2e-dead-term-${suffix}-${Date.now()}`
  const worktreeId = await page.evaluate(async (worktreeName) => {
    const store = window.__store
    const state = store?.getState()
    const activeWorktree = state?.getKnownWorktreeById(state.activeWorktreeId ?? '')
    if (!store || !state || !activeWorktree) {
      throw new Error('No active worktree')
    }
    const result = await state.createWorktree(
      activeWorktree.repoId,
      worktreeName,
      undefined,
      'skip'
    )
    await state.fetchWorktrees(activeWorktree.repoId)
    state.setActiveRepo(activeWorktree.repoId)
    state.setActiveView('terminal')
    state.setActiveWorktree(result.worktree.id)
    if (state.reconcileWorktreeTabModel(result.worktree.id).renderableTabCount === 0) {
      const tab = state.createTab(result.worktree.id, undefined, undefined, {
        pendingActivationSpawn: true
      })
      state.setActiveTab(tab.id)
    }
    state.revealWorktreeInSidebar(result.worktree.id)
    return result.worktree.id
  }, name)
  await waitForActiveTerminalManager(page)
  await splitActiveTerminalPane(page, direction)
  return worktreeId
}

export async function removeWorktreeViaStore(page: TestPage, worktreeId: string): Promise<void> {
  await page.evaluate(async (id) => {
    const state = window.__store?.getState()
    if (!state) {
      throw new Error('Worktree cleanup requires the app store')
    }
    const worktree = state.getKnownWorktreeById(id)
    if (!worktree) {
      return
    }
    const result = await state.removeWorktree(
      { id, executionHostId: worktree.hostId ?? null },
      true
    )
    if (!result.ok) {
      throw new Error(`Worktree cleanup failed: ${result.error}`)
    }
  }, worktreeId)
}

/**
 * Poll until every pane in the active tab's PaneManager has non-empty buffer
 * content. A dead terminal has an empty serialize() result because the WebGL
 * canvas never painted the shell prompt.
 */
export async function waitForAllPanesToHaveContent(
  page: TestPage,
  label: string,
  timeoutMs = 15_000
): Promise<void> {
  await expect
    .poll(
      async () => {
        return page.evaluate(() => {
          const store = window.__store
          if (!store) {
            return { ok: false, reason: 'no store' }
          }
          const state = store.getState()
          const wId = state.activeWorktreeId
          if (!wId) {
            return { ok: false, reason: 'no active worktree' }
          }
          const tabs = state.tabsByWorktree[wId] ?? []
          const tabId =
            state.activeTabType === 'terminal'
              ? state.activeTabId
              : (state.activeTabIdByWorktree?.[wId] ?? tabs[0]?.id)
          if (!tabId) {
            return { ok: false, reason: 'no tab' }
          }

          const manager = window.__paneManagers?.get(tabId)
          if (!manager) {
            return { ok: false, reason: 'no manager' }
          }
          const panes = manager.getPanes?.() ?? []
          if (panes.length === 0) {
            return { ok: false, reason: 'no panes' }
          }

          const paneStates = panes.map((pane) => {
            const content = pane.serializeAddon?.serialize?.() ?? ''
            // oxlint-disable-next-line no-control-regex -- stripping terminal control chars is intentional
            const stripped = content.replace(/[\s\x00-\x1f]/g, '')
            return { id: pane.id, hasContent: stripped.length > 0 }
          })

          return { ok: paneStates.every((p) => p.hasContent), paneStates }
        })
      },
      {
        timeout: timeoutMs,
        message: `[${label}] Not all terminal panes have rendered content (possible dead terminal)`
      }
    )
    .toMatchObject({ ok: true })
}

/**
 * Log WebGL canvas state for diagnostics. In headful mode, visible panes
 * should have WebGL canvases; hidden panes (suspended rendering) should not.
 */
export async function checkWebglState(page: TestPage, label: string): Promise<void> {
  const paneStates = await page.evaluate(() => {
    const containers = document.querySelectorAll('.pane[data-pane-id]')
    return Array.from(containers).map((c) => ({
      paneId: (c as HTMLElement).dataset.paneId,
      canvasCount: c.querySelectorAll('canvas').length
    }))
  })

  const hasCanvas = paneStates.some((p) => p.canvasCount > 0)
  if (!hasCanvas) {
    console.warn(`[${label}] No WebGL canvases — DOM renderer only.`)
  }
}
