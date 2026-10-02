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
  const transcriptAgent = data.transcript?.agent
  if (data.transcript && transcriptAgent && !paneHasNativeFork) {
    options.unshift({ kind: 'transcript', agent: transcriptAgent, prompt: data.transcript.prompt })
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

/** The option behind `selectedKey`; a transcript replaced by its pane's native session follows it there. */
export function resolveSelectedAgentSessionForkOption(
  options: AgentSessionForkSource[],
  selectedKey: string,
  preselectedPaneKey: string | null
): AgentSessionForkSource {
  const selected = options.find((option) => agentSessionForkOptionKey(option) === selectedKey)
  if (selected) {
    return selected
  }
  const paneSession =
    selectedKey === 'transcript'
      ? options.find(
          (option) => option.kind === 'native' && option.session.paneKey === preselectedPaneKey
        )
      : undefined
  // Why: a session can vanish while the dialog is open; fall back to "No agent", never a stale one.
  return paneSession ?? { kind: 'none' }
}
