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

/** The option forking the preselected pane itself: its native session or its transcript. */
function preselectedPaneOption(
  options: AgentSessionForkSource[],
  preselectedPaneKey: string | null
): AgentSessionForkSource | undefined {
  if (preselectedPaneKey === null) {
    return undefined
  }
  return options.find(
    (option) =>
      option.kind === 'transcript' ||
      (option.kind === 'native' && option.session.paneKey === preselectedPaneKey)
  )
}

/** True when the fork came from a pane that has nothing to fork, e.g. an empty terminal. */
export function isPreselectedPaneWithoutOption(
  options: AgentSessionForkSource[],
  preselectedPaneKey: string | null
): boolean {
  return preselectedPaneKey !== null && !preselectedPaneOption(options, preselectedPaneKey)
}

export function initialAgentSessionForkOptionKey(
  options: AgentSessionForkSource[],
  preselectedPaneKey: string | null
): string {
  const preselected = preselectedPaneOption(options, preselectedPaneKey)
  // Why: a pane with nothing to fork must not silently default to another pane's conversation.
  if (!preselected && preselectedPaneKey !== null) {
    return agentSessionForkOptionKey({ kind: 'none' })
  }
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
