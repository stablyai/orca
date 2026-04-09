import type { WorktreeSetupLaunch } from '../../../shared/types'
import { buildSetupRunnerCommand } from './setup-runner'

type WorktreeActivationStore = {
  tabsByWorktree: Record<string, { id: string }[]>
  createTab: (worktreeId: string) => { id: string }
  setActiveTab: (tabId: string) => void
  queueTabSetupSplit: (
    tabId: string,
    startup: { command: string; env?: Record<string, string> }
  ) => void
}

export function ensureWorktreeHasInitialTerminal(
  store: WorktreeActivationStore,
  worktreeId: string,
  setup?: WorktreeSetupLaunch
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
}
