/**
 * Journeys ported from the closed layout-core branch: STA-9417's host-created setup split, and an
 * agent pane slept through the sidebar so quit and relaunch resume it.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { expect } from './orca-app'
import { RuntimeClient } from '../../../src/cli/runtime/client'
import type { RuntimeTerminalListResult } from '../../../src/shared/runtime-types'
import type { RuntimeWorktreeCreateResult } from '../../../src/shared/runtime-worktree-contracts'
import { activateWorkspaceByClick, sleepWorkspaceViaSidebar } from './slept-workspace-probe'
import { ensureTerminalVisible, waitForSessionReady } from './store'
import { splitActiveTerminalPane, waitForActiveTerminalManager } from './terminal'
import { waitForBoundPanes, type FolderWorkspaceSetup } from './terminal-layout-journeys'
import { bootstrapFirstLaunch, seededRepoPathOrSkip } from './terminal-restart-persistence'

/**
 * Main reveals the split to the window only if the window's runtime graph already lists the first
 * terminal. The natural repro lost that race; an idle e2e window wins it in ~80 ms, so hold the
 * window busy from just after the first reveal until well past main's split.
 */
async function stallRendererOnFirstSetupTab(page: Page): Promise<void> {
  await page.evaluate(() => {
    const store = window.__store!
    const unsubscribe = store.subscribe((state) => {
      const revealed = Object.entries(state.tabsByWorktree).some(
        ([worktreeId, tabs]) => worktreeId.endsWith('parity-setup') && (tabs ?? []).length > 0
      )
      if (!revealed) {
        return
      }
      unsubscribe()
      // After the reveal's own task, before the graph sync it scheduled.
      setTimeout(() => {
        const until = performance.now() + 3_000
        while (performance.now() < until) {
          // Busy, as a loaded renderer is: no timer or IPC runs.
        }
      }, 0)
    })
  })
}

/**
 * STA-9417's shape: the CLI creates a worktree whose setup script runs in a split of its first
 * terminal, with the window open on another worktree; the user then opens it for the first time.
 */
export async function addHostCreatedSetupSplitWorktree(
  page: Page,
  userDataDir: string
): Promise<FolderWorkspaceSetup> {
  const { worktreeId } = await bootstrapFirstLaunch(page, seededRepoPathOrSkip())
  const repoPath = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-parity-setup-')))
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: repoPath, stdio: 'pipe' })
  }
  git('init', '-b', 'main')
  git('config', 'user.email', 'e2e@test.local')
  git('config', 'user.name', 'E2E Test')
  writeFileSync(path.join(repoPath, 'orca.yaml'), 'scripts:\n  setup: echo SETUP_COMPLETE\n')
  git('add', '-A')
  git('commit', '-m', 'setup hook')
  await page.evaluate(() =>
    window.__store!.getState().updateSettings({ setupScriptLaunchMode: 'split-vertical' })
  )
  await stallRendererOnFirstSetupTab(page)
  const client = new RuntimeClient(userDataDir, 30_000)
  const added = await client.call<{ repo: { id: string } }>('repo.add', {
    path: repoPath,
    kind: 'git'
  })
  const created = await client.call<RuntimeWorktreeCreateResult>('worktree.create', {
    repo: `id:${added.result.repo.id}`,
    name: 'parity-setup',
    noParent: true,
    activate: false,
    setupDecision: 'run'
  })
  const worktreePath = created.result.worktree.path
  return {
    worktreeId,
    pathLabels: { [repoPath]: '<setup-repo>', [worktreePath]: '<setup-worktree>' },
    cleanup: () => {
      rmSync(worktreePath, { recursive: true, force: true })
      rmSync(repoPath, { recursive: true, force: true })
    }
  }
}

/** Opens the setup worktree the way a user does; returns its id once main ran both terminals. */
export async function openSetupSplitWorktree(page: Page, userDataDir: string): Promise<string> {
  let setupWorktreeId: string | undefined
  await expect
    .poll(async () => {
      setupWorktreeId = await page.evaluate(async () => {
        const store = window.__store!
        await store.getState().fetchRepos()
        for (const repo of store.getState().repos) {
          await store.getState().fetchWorktrees(repo.id)
        }
        return Object.values(store.getState().worktreesByRepo)
          .flat()
          .find((worktree) => worktree.branch === 'refs/heads/parity-setup')?.id
      })
      return setupWorktreeId
    })
    .toBeDefined()
  const client = new RuntimeClient(userDataDir, 30_000)
  // Main has spawned the first terminal and the setup split before the user opens the worktree.
  let hostPtyIds: string[] = []
  await expect
    .poll(async () => {
      const listed = await client
        .call<RuntimeTerminalListResult>('terminal.list', { worktree: `id:${setupWorktreeId!}` })
        .catch(() => null)
      hostPtyIds = (listed?.result.terminals ?? []).flatMap((terminal) =>
        terminal.ptyId ? [terminal.ptyId] : []
      )
      return hostPtyIds.length
    })
    .toBe(2)
  await activateWorkspaceByClick(page, setupWorktreeId!)
  await waitForActiveTerminalManager(page)
  return setupWorktreeId!
}

/** A slept agent pane, through the user's sidebar Sleep, so the quit and relaunch resume it. */
export async function sleepAgentPane(page: Page, worktreeId: string): Promise<void> {
  await splitActiveTerminalPane(page, 'vertical')
  await waitForBoundPanes(page, 2)
  await page.evaluate((id) => {
    const state = window.__store!.getState()
    const tabId = state.activeTabId!
    const manager = window.__paneManagers!.get(tabId)!
    const leafId = manager.getLeafId(manager.getActivePane()!.id)!
    state.setAgentStatus(
      `${tabId}:${leafId}`,
      { state: 'working', prompt: 'finish the task', agentType: 'codex' },
      'Codex',
      undefined,
      { worktreeId: id },
      { providerSession: { key: 'session_id', id: 'parity-sleep-session' } }
    )
  }, worktreeId)
  await sleepWorkspaceViaSidebar(page, worktreeId)
  await expect
    .poll(() =>
      page.evaluate((id) => {
        const state = window.__store!.getState()
        const slept = Object.values(state.sleepingAgentSessionsByPaneKey).some(
          (record) => record.worktreeId === id
        )
        const live = (state.tabsByWorktree[id] ?? []).some(
          (tab) => (state.ptyIdsByTabId[tab.id]?.length ?? 0) > 0
        )
        return slept && !live
      }, worktreeId)
    )
    .toBe(true)
}

/** A slept worktree is not active after relaunch; the user's click wakes it and resumes the agent. */
export async function wakeByClick(page: Page, worktreeId: string): Promise<void> {
  await waitForSessionReady(page)
  await activateWorkspaceByClick(page, worktreeId)
  await ensureTerminalVisible(page)
  await waitForActiveTerminalManager(page, 30_000)
}
