import type { WorktreeSetupLaunch } from '../../../shared/worktree/launch-types'
import { buildSetupRunnerCommand } from './setup-runner'
import { translate } from '@/i18n/i18n'
import type {
  InitialTerminalOptions,
  WorktreeActivationStore
} from '@/lib/worktree-activation-store-contract'

// Accept main runner files and expanded TaskPage commands without synthesizing another script.
export type IssueCommandLaunch =
  | WorktreeSetupLaunch
  | { command: string; env?: Record<string, string> }

export function queueSetupAndIssueCommands(
  store: WorktreeActivationStore,
  worktreeId: string,
  /** Null when the caller opens its own primary surface: setup still gets its own tab, with no terminal selection to restore. */
  terminalTabId: string | null,
  setup: WorktreeSetupLaunch | undefined,
  issueCommand: IssueCommandLaunch | undefined,
  wrappedSetupCommandStr: string | undefined,
  opts: InitialTerminalOptions | undefined
): void {
  if (setup) {
    const setupCommand = {
      command:
        wrappedSetupCommandStr ??
        setup.command ??
        buildSetupRunnerCommand(setup.runnerScriptPath, setup.shell),
      env: setup.envVars
    }
    const setupTab = store.createTab(worktreeId, undefined, undefined, {
      recordInteraction: false,
      ...(opts?.activateCreatedTabs === false ? { activate: false } : {}),
      pendingStartup: setupCommand
    })
    // createTab auto-activates; restore primary focus while Setup runs in background.
    if (opts?.activateCreatedTabs !== false && terminalTabId) {
      store.setActiveTab(terminalTabId)
    }
    store.setTabCustomTitle(setupTab.id, translate('worktree.setupTerminalTitle', 'Setup'), {
      recordInteraction: false
    })
  }

  // Queue issue work independently in its own split so setup and automation run in parallel.
  if (issueCommand && terminalTabId) {
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
