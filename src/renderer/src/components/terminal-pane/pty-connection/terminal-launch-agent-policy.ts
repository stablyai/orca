import { agentTypeToIconAgent } from '@/lib/agent-status'
import { useAppStore } from '@/store'
import type { TuiAgent } from '../../../../../shared/tui-agent'
import { isTuiAgent } from '../../../../../shared/tui-agent-config'
import {
  paneShouldAnswerOscColorQueries,
  resolvePaneLaunchAgentCandidate,
  type PaneLaunchAgentPaneSlice
} from './pane-launch-agent-candidate'

export function createTerminalLaunchAgentPolicy(services: {
  paneKey: string
  worktreeId: string
  tabId: string
  startup: PaneLaunchAgentPaneSlice['startup']
}) {
  const paneHasLiveHookAgentIcon = (state: ReturnType<typeof useAppStore.getState>): boolean => {
    const entry = state.agentStatusByPaneKey[services.paneKey]
    return entry?.state !== 'done' && Boolean(agentTypeToIconAgent(entry?.agentType))
  }
  // Why the shared module: the same ladder answers the 133;D guard, the visible-pane
  // resampler, and the OSC color-reply skip, and it is the one piece of this installer
  // that is a pure rule worth testing on its own.
  const panePane = (): PaneLaunchAgentPaneSlice => ({
    worktreeId: services.worktreeId,
    tabId: services.tabId,
    paneKey: services.paneKey,
    startup: services.startup
  })
  const resolveLaunchAgentCandidate = (
    state: ReturnType<typeof useAppStore.getState>
  ): string | undefined => resolvePaneLaunchAgentCandidate(state, panePane())
  const paneExpectsLaunchAgent = (state: ReturnType<typeof useAppStore.getState>): boolean =>
    Boolean(resolveLaunchAgentCandidate(state))
  // Why: the concrete TUI agent a fresh spawn is expected to launch, used to seed
  // a command-start confirmation on no-OSC shells (Git Bash/cmd) that never emit
  // one. Returns null when the expectation isn't a recognized TUI agent.
  const resolveExpectedLaunchTuiAgent = (): TuiAgent | null => {
    const candidate = resolveLaunchAgentCandidate(useAppStore.getState())
    return isTuiAgent(candidate) ? candidate : null
  }
  // Why: jcode themes itself; answering its OSC color burst can land before its
  // composer is ready and render the reply as pre-typed text (the main-side
  // startup ingress already skips it, the renderer must skip the answer too).
  const shouldAnswerPaneOscColorQueries = (): boolean =>
    paneShouldAnswerOscColorQueries(useAppStore.getState(), panePane())
  return {
    paneHasLiveHookAgentIcon,
    paneExpectsLaunchAgent,
    resolveExpectedLaunchTuiAgent,
    shouldAnswerPaneOscColorQueries
  }
}
