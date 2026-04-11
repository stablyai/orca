import type { WorktreeSetupLaunch } from '../../../shared/types'
import { buildSetupRunnerCommand } from './setup-runner'
import { useAppStore } from '@/store'
import { findWorktreeById } from '@/store/slices/worktree-helpers'

type WorktreeActivationStore = {
  tabsByWorktree: Record<string, { id: string }[]>
  createTab: (worktreeId: string) => { id: string }
  setActiveTab: (tabId: string) => void
  queueTabSetupSplit: (
    tabId: string,
    startup: { command: string; env?: Record<string, string> }
  ) => void
  queueTabIssueCommandSplit: (
    tabId: string,
    startup: { command: string; env?: Record<string, string> }
  ) => void
}

/**
 * Shared activation sequence used by the worktree palette, AddRepoDialog,
 * and AddWorktreeDialog. Covers: cross-repo `activeRepoId` switch,
 * `activeView` from settings, `setActiveWorktree`, initial terminal
 * creation, sidebar filter clearing, and sidebar reveal.
 *
 * The caller only passes `worktreeId`; the helper derives `repoId`
 * internally via `findWorktreeById`. Returns early without side effects
 * if the worktree is not found (e.g. deleted between palette open and select).
 */
export function activateAndRevealWorktree(
  worktreeId: string,
  opts?: {
    setup?: WorktreeSetupLaunch
    issueCommand?: { command: string; env?: Record<string, string> }
  }
): boolean {
  const state = useAppStore.getState()
  const wt = findWorktreeById(state.worktreesByRepo, worktreeId)
  if (!wt) {
    return false
  }

  // 1. Set activeRepoId if crossing repos
  if (wt.repoId !== state.activeRepoId) {
    state.setActiveRepo(wt.repoId)
  }

  // 2. Switch activeView from settings to terminal
  if (state.activeView === 'settings') {
    state.setActiveView('terminal')
  }

  // 3. Core activation: sets activeWorktreeId, restores per-worktree state,
  // clears unread, bumps dead PTY generations, triggers GitHub refresh
  state.setActiveWorktree(worktreeId)

  // 4. Ensure a focusable surface exists for externally-created worktrees
  ensureWorktreeHasInitialTerminal(
    useAppStore.getState(),
    worktreeId,
    opts?.setup,
    opts?.issueCommand
  )

  // 5. Clear sidebar filters that would hide the target worktree
  // Why: revealWorktreeInSidebar relies on the worktree card being rendered
  // in the sidebar. If sidebar filters exclude the target, the card is never
  // rendered and the reveal silently no-ops.
  if (state.searchQuery) {
    state.setSearchQuery('')
  }
  if (state.filterRepoIds.length > 0 && !state.filterRepoIds.includes(wt.repoId)) {
    state.setFilterRepoIds([])
  }

  // 6. Reveal in sidebar
  state.revealWorktreeInSidebar(worktreeId)

  return true
}

export function ensureWorktreeHasInitialTerminal(
  store: WorktreeActivationStore,
  worktreeId: string,
  setup?: WorktreeSetupLaunch,
  issueCommand?: { command: string; env?: Record<string, string> }
): void {
  const existingTabs = store.tabsByWorktree[worktreeId] ?? []
  if (existingTabs.length > 0) {
    return
  }

  const terminalTab = store.createTab(worktreeId)
  store.setActiveTab(terminalTab.id)

  // Why: run the setup script in a split pane to the right so the main
  // terminal stays immediately interactive. The TerminalPane reads this
  // signal on mount, creates the initial pane clean, then splits right
  // and injects the setup command into the new pane's PTY.
  if (setup) {
    store.queueTabSetupSplit(terminalTab.id, {
      command: buildSetupRunnerCommand(setup.runnerScriptPath),
      env: setup.envVars
    })
  }

  // Why: when the user links a GitHub issue and opts into that repo's
  // per-user issue automation, spawn a separate split pane to run the
  // agent command. Queued independently from setup so both can start in
  // parallel; repo bootstrap and personal issue workflows are separate
  // concerns, so Orca should not invent a dependency between them.
  if (issueCommand) {
    store.queueTabIssueCommandSplit(terminalTab.id, issueCommand)
  }
}
