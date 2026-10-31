import { isTuiAgent } from '../../../../../shared/tui-agent-config'
import type { TuiAgent } from '../../../../../shared/tui-agent'
import { recognizeAgentLaunchCommand } from '../../../../../shared/agent-command-line-intent'
import { COMMAND_TOKEN_SCAN_MAX_CHARS } from '../../../../../shared/command-token-scanner'

/** The store slice the launch-agent ladder reads. */
export type PaneLaunchAgentStoreSlice = {
  tabsByWorktree: Record<string, { id: string; launchAgent?: string }[] | undefined>
  agentLaunchConfigByPaneKey: Record<string, { identity?: { agentType?: string } } | undefined>
}

export type PaneLaunchAgentPaneSlice = {
  worktreeId: string
  tabId: string
  paneKey: string
  startup?: { command?: string; launchAgent?: string; initialAgentStatus?: { agent?: string } }
}

/** Share expected-agent precedence across finish confirmation, visible sampling and color-query policy; launch config may precede its identity. */
export function resolvePaneLaunchAgentCandidate(
  state: PaneLaunchAgentStoreSlice,
  pane: PaneLaunchAgentPaneSlice
): string | undefined {
  const registered = state.agentLaunchConfigByPaneKey[pane.paneKey]?.identity?.agentType
  const command = pane.startup?.command
  return (
    state.tabsByWorktree[pane.worktreeId]?.find((tab) => tab.id === pane.tabId)?.launchAgent ??
    pane.startup?.launchAgent ??
    pane.startup?.initialAgentStatus?.agent ??
    (isTuiAgent(registered) ? registered : undefined) ??
    (command && command.length <= COMMAND_TOKEN_SCAN_MAX_CHARS
      ? recognizeAgentLaunchCommand(command)?.agent
      : undefined)
  )
}

/** The same ladder, narrowed to a recognized TUI agent. */
export function resolvePaneLaunchTuiAgent(
  state: PaneLaunchAgentStoreSlice,
  pane: PaneLaunchAgentPaneSlice
): TuiAgent | null {
  const candidate = resolvePaneLaunchAgentCandidate(state, pane)
  return isTuiAgent(candidate) ? candidate : null
}

// jcode queries colors before its input loop is ready; skip renderer replies like main ingress to avoid pre-typed composer text (#12112).
export function paneShouldAnswerOscColorQueries(
  state: PaneLaunchAgentStoreSlice,
  pane: PaneLaunchAgentPaneSlice
): boolean {
  return resolvePaneLaunchTuiAgent(state, pane) !== 'jcode'
}
