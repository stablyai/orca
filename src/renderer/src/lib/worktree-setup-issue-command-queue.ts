import type { WorktreeSetupLaunch } from '../../../shared/worktree/launch-types'
import { buildSetupRunnerCommand } from './setup-runner'
import { useAppStore } from '@/store'
import type {
  InitialTerminalOptions,
  WorktreeActivationStore
} from '@/lib/worktree-activation-store-contract'

// Why: accept either a main-generated runner script or a plain TaskPage command string, so callers needn't synthesize a runner file.
export type IssueCommandLaunch =
  | WorktreeSetupLaunch
  | { command: string; env?: Record<string, string> }

export function queueSetupAndIssueCommands(
  store: WorktreeActivationStore,
  worktreeId: string,
  terminalTabId: string,
  setup: WorktreeSetupLaunch | undefined,
  issueCommand: IssueCommandLaunch | undefined,
  wrappedSetupCommandStr: string | undefined,
  opts: InitialTerminalOptions | undefined
): void {
  // Why: setup launch location is user-configurable — 'new-tab' keeps setup output off the primary pane; splits keep it adjacent.
  if (setup) {
    const mode = useAppStore.getState().settings?.setupScriptLaunchMode ?? 'new-tab'
    const setupCommand = {
      command:
        wrappedSetupCommandStr ??
        setup.command ??
        buildSetupRunnerCommand(setup.runnerScriptPath, setup.shell),
      env: setup.envVars
    }
    if (mode === 'new-tab') {
      const setupTab = store.createTab(worktreeId, undefined, undefined, {
        recordInteraction: false,
        ...(opts?.activateCreatedTabs === false ? { activate: false } : {})
      })
      // Why: createTab auto-activates the new tab; revert so focus stays on the primary terminal while Setup runs in the background.
      if (opts?.activateCreatedTabs !== false) {
        store.setActiveTab(terminalTabId)
      }
      // Why: customTitle overrides the auto "Terminal N" label everywhere the tab renders, so it's the authoritative label source.
      store.setTabCustomTitle(setupTab.id, 'Setup', { recordInteraction: false })
      store.queueTabStartupCommand(setupTab.id, setupCommand)
    } else {
      store.queueTabSetupSplit(terminalTabId, {
        ...setupCommand,
        direction: mode === 'split-horizontal' ? 'horizontal' : 'vertical'
      })
    }
  }

  // Why: issue automation runs in its own split, queued independently from setup so both can start in parallel (separate concerns).
  if (issueCommand) {
    // Why: WorktreeSetupLaunch carries a runner-script file to shell out to; the TaskPage variant is already an expanded command string.
    const queuedIssueCommand =
      'runnerScriptPath' in issueCommand
        ? {
            command: buildSetupRunnerCommand(issueCommand.runnerScriptPath, issueCommand.shell),
            env: issueCommand.envVars
          }
        : { command: issueCommand.command, env: issueCommand.env }
    store.queueTabIssueCommandSplit(terminalTabId, queuedIssueCommand)
  }
}
