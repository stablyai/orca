import type { AgentSessionForkSource } from '@/lib/agent-session-fork-flow'
import type { ForkableAgentSession } from '@/lib/worktree-agent-fork-sessions'
import type { AgentSessionForkModalData } from './agent-session-fork-modal-data'

export function agentSessionForkOptionKey(option: AgentSessionForkSource): string {
  return option.kind === 'native' ? `native:${option.session.providerSessionId}` : option.kind
}

export function buildAgentSessionForkOptions(
  sessions: ForkableAgentSession[],
  data: AgentSessionForkModalData
): AgentSessionForkSource[] {
  const options: AgentSessionForkSource[] = sessions.map((session) => ({
    kind: 'native',
    session
  }))
  const paneHasNativeFork = sessions.some((session) => session.paneKey === data.preselectedPaneKey)
  if (data.transcript && !paneHasNativeFork) {
    options.unshift({ kind: 'transcript', ...data.transcript })
  }
  options.push({ kind: 'none' })
  return options
}

export function initialAgentSessionForkOptionKey(
  options: AgentSessionForkSource[],
  preselectedPaneKey: string | null
): string {
  const preselected = options.find(
    (option) => option.kind === 'native' && option.session.paneKey === preselectedPaneKey
  )
  return agentSessionForkOptionKey(preselected ?? options[0] ?? { kind: 'none' })
}
