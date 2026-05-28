/**
 * Shared helpers for dead-terminal reproduction tests.
 *
 * These helpers exercise the real production worktree-creation-with-setup-split
 * flow and verify that terminal panes render content after the split.
 */

import { expect } from '@playwright/test'
import { execFileSync } from 'child_process'
import { writeFileSync } from 'fs'
import path from 'path'
import type { getActiveWorktreeId } from './store'

type TestPage = Parameters<typeof getActiveWorktreeId>[0]

const SETUP_HOOK_CONTENT = 'scripts:\n  setup: echo SETUP_COMPLETE\n'

async function ensureSetupHookCommitted(page: TestPage): Promise<void> {
  const activeWorktreePath = await page.evaluate(() => {
    const state = window.__store?.getState()
    if (!state?.activeWorktreeId) {
      throw new Error('No active worktree')
    }
    const activeWorktree = Object.values(state.worktreesByRepo)
      .flat()
      .find((wt) => wt.id === state.activeWorktreeId)
    if (!activeWorktree) {
      throw new Error('Active worktree not found in store')
    }
    return activeWorktree.path
  })

  writeFileSync(path.join(activeWorktreePath, 'orca.yaml'), SETUP_HOOK_CONTENT, 'utf-8')
  execFileSync('git', ['add', 'orca.yaml'], { cwd: activeWorktreePath, stdio: 'pipe' })

  try {
    execFileSync('git', ['diff', '--cached', '--quiet'], { cwd: activeWorktreePath, stdio: 'pipe' })
  } catch {
    // Why: worktree creation reads orca.yaml from the created worktree, so the
    // temp repo must commit this hook before `git worktree add` copies it.
    execFileSync('git', ['commit', '-m', 'Add e2e setup hook'], {
      cwd: activeWorktreePath,
      stdio: 'pipe'
    })
  }
}

/**
 * Create a worktree with setup via the real IPC flow, then activate it
 * replicating the exact activateAndRevealWorktree + ensureWorktreeHasInitialTerminal
 * path. The setup split is queued on the tab BEFORE the TerminalPane mounts,
 * matching production timing.
 */
export async function createAndActivateWorktreeWithSetup(
  page: TestPage,
  suffix: string,
  direction: 'vertical' | 'horizontal'
): Promise<string> {
  await ensureSetupHookCommitted(page)

  const name = `e2e-dead-term-${suffix}-${Date.now()}`
  return page.evaluate(
    async ({ worktreeName, direction }) => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }

      const state = store.getState()
      const activeWorktreeId = state.activeWorktreeId
      if (!activeWorktreeId) {
        throw new Error('No active worktree')
      }

      const activeWorktree = Object.values(state.worktreesByRepo)
        .flat()
        .find((wt) => wt.id === activeWorktreeId)
      if (!activeWorktree) {
        throw new Error('Active worktree not found in store')
      }

      const result = await state.createWorktree(
        activeWorktree.repoId,
        worktreeName,
        undefined,
        'run'
      )
      await state.fetchWorktrees(activeWorktree.repoId)
      const worktreeId = result.worktree.id

      if (activeWorktree.repoId !== state.activeRepoId) {
        state.setActiveRepo(activeWorktree.repoId)
      }
      if (store.getState().activeView !== 'terminal') {
        state.setActiveView('terminal')
      }
      state.setActiveWorktree(worktreeId)

      const { renderableTabCount } = state.reconcileWorktreeTabModel(worktreeId)
      if (renderableTabCount > 0) {
        return worktreeId
      }

      const tab = state.createTab(worktreeId, undefined, undefined, {
        pendingActivationSpawn: true
      })
      state.setActiveTab(tab.id)

      if (result.setup) {
        const runnerPath = result.setup.runnerScriptPath
        const command = `bash ${runnerPath}`
        state.queueTabSetupSplit(tab.id, {
          command,
          env: result.setup.envVars,
          direction
        })
      }

      state.revealWorktreeInSidebar(worktreeId)
      return worktreeId
    },
    { worktreeName: name, direction }
  )
}

export async function removeWorktreeViaStore(page: TestPage, worktreeId: string): Promise<void> {
  await page.evaluate(async (id) => {
    try {
      await window.__store?.getState().removeWorktree(id, true)
    } catch {
      /* best-effort */
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
