import type { TuiAgent } from '../../../shared/tui-agent'
import { isTuiAgentEnabled } from '../../../shared/tui-agent-selection'

export const SIDE_QUEST_AGENTS = ['claude', 'codex'] as const

export type SideQuestAgent = (typeof SIDE_QUEST_AGENTS)[number]

export function isSideQuestAgent(
  agent: TuiAgent | string | null | undefined
): agent is SideQuestAgent {
  return agent === 'claude' || agent === 'codex'
}

export function resolveSideQuestAgent(args: {
  detectedAgent?: TuiAgent | string | null
  launchedAgent?: TuiAgent | string | null
  defaultAgent?: TuiAgent | 'blank' | string | null
  availableAgents?: readonly (TuiAgent | string)[] | null
  disabledAgents?: Iterable<unknown> | null
}): SideQuestAgent | null {
  const runningCandidate = [args.detectedAgent, args.launchedAgent].find(
    (candidate): candidate is SideQuestAgent =>
      isSideQuestAgent(candidate) && isTuiAgentEnabled(candidate, args.disabledAgents)
  )
  if (runningCandidate) {
    return runningCandidate
  }

  const defaultAgent = args.defaultAgent
  if (!isSideQuestAgent(defaultAgent)) {
    return null
  }
  return isTuiAgentEnabled(defaultAgent, args.disabledAgents) &&
    args.availableAgents?.includes(defaultAgent)
    ? defaultAgent
    : null
}

export function sideQuestReadOnlyAgentArgs(agent: SideQuestAgent): string {
  // Why: Side Quests share a live worktree with the main agent, so their
  // default launch must prevent a second writer from racing the primary task;
  // Codex uses low effort so lightweight side research stays responsive.
  return agent === 'claude'
    ? '--permission-mode plan'
    : '--sandbox read-only --ask-for-approval never -c model_reasoning_effort=low'
}
