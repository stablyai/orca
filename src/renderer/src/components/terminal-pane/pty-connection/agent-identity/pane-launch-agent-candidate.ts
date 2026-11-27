import { isTuiAgent } from '../../../../../../shared/agent-launch/catalog/tui-agent-config'
import type { TuiAgent } from '../../../../../../shared/agent-launch/catalog/tui-agent'
import { recognizeAgentLaunchCommand } from '../../../../../../shared/agent-launch/startup/agent-command-line-intent'
import { COMMAND_TOKEN_SCAN_MAX_CHARS } from '../../../../../../shared/shell/command-resolution/command-token-scanner'

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

/** Share expected-agent precedence across finish confirmation and visible sampling; launch config may precede its identity. */
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

function skipsOscColorQueryReplies(agent: string | null | undefined): boolean {
  return agent === 'jcode' || agent === 'antigravity'
}

function recognizedStartupAgent(command: string | undefined): TuiAgent | null {
  if (!command || command.length > COMMAND_TOKEN_SCAN_MAX_CHARS) {
    return null
  }
  const agent = recognizeAgentLaunchCommand(command)?.agent
  return isTuiAgent(agent) ? agent : null
}

// This pane's own launch evidence receives the reply; the tab can name another split (#51192).
function paneOscColorQueryAgent(
  state: PaneLaunchAgentStoreSlice,
  pane: PaneLaunchAgentPaneSlice
): TuiAgent | null {
  if (isTuiAgent(pane.startup?.launchAgent)) {
    return pane.startup.launchAgent
  }
  const initialAgent = pane.startup?.initialAgentStatus?.agent
  if (isTuiAgent(initialAgent)) {
    return initialAgent
  }
  const registered = state.agentLaunchConfigByPaneKey[pane.paneKey]?.identity?.agentType
  if (isTuiAgent(registered)) {
    return registered
  }
  return recognizedStartupAgent(pane.startup?.command) ?? resolvePaneLaunchTuiAgent(state, pane)
}

// jcode and agy paint an early OSC 10/11 reply as composer text (#12112, #51192).
export function paneShouldAnswerOscColorQueries(
  state: PaneLaunchAgentStoreSlice,
  pane: PaneLaunchAgentPaneSlice
): boolean {
  return !skipsOscColorQueryReplies(paneOscColorQueryAgent(state, pane))
}
