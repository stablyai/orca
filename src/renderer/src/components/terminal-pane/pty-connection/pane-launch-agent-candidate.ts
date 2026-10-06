import { isTuiAgent } from '../../../../../shared/tui-agent-config'
import type { TuiAgent } from '../../../../../shared/tui-agent'

/** The store slice the launch-agent ladder reads. */
export type PaneLaunchAgentStoreSlice = {
  tabsByWorktree: Record<string, { id: string; launchAgent?: string }[] | undefined>
  agentLaunchConfigByPaneKey: Record<string, { identity?: { agentType?: string } } | undefined>
}

export type PaneLaunchAgentPaneSlice = {
  worktreeId: string
  tabId: string
  paneKey: string
  startup?: { launchAgent?: string; initialAgentStatus?: { agent?: string } }
}

/**
 * The launch agent a pane is expected to run, from the first signal that has one.
 *
 * Why one ladder: the 133;D confirmation guard, the visible-pane resampler, and the
 * OSC color-reply skip all key off "what agent is this pane", and a second copy would
 * drift. Why `identity` is optional: a launch config is registered before its identity
 * lands, and reading through it unguarded threw on every pane connect once the
 * color-reply skip started calling this on all of them.
 */
export function resolvePaneLaunchAgentCandidate(
  state: PaneLaunchAgentStoreSlice,
  pane: PaneLaunchAgentPaneSlice
): string | undefined {
  const registered = state.agentLaunchConfigByPaneKey[pane.paneKey]?.identity?.agentType
  return (
    state.tabsByWorktree[pane.worktreeId]?.find((tab) => tab.id === pane.tabId)?.launchAgent ??
    pane.startup?.launchAgent ??
    pane.startup?.initialAgentStatus?.agent ??
    (isTuiAgent(registered) ? registered : undefined)
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

// Why: jcode paints its own theme and fires its OSC 10/11 burst before its TUI input
// loop is ready, so the cooked reply lands in the composer as pre-typed text (the same
// class as #12112, which fixed opencode). The main-side startup ingress already skips
// it; the renderer's capability handlers must skip the answer too.
export function paneShouldAnswerOscColorQueries(
  state: PaneLaunchAgentStoreSlice,
  pane: PaneLaunchAgentPaneSlice
): boolean {
  return resolvePaneLaunchTuiAgent(state, pane) !== 'jcode'
}
