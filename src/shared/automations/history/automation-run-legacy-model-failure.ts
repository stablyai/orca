import { AGENT_SESSION_FAILURE_COPY } from '../../agent-session/failures/agent-session-failure-copy'

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** The Chat's model sentences, built from their own templates so a wording change can't slip past. */
const LEGACY_MODEL_SENTENCES = (['modelUnavailable', 'modelUnavailableUpdate'] as const).map(
  (id) => {
    let agentSeen = false
    const source = escapeRegExp(AGENT_SESSION_FAILURE_COPY[id]).replace(
      /\\\{\\\{(\w+)\\\}\\\}/g,
      (_match, name: string) => {
        if (name === 'agent') {
          const group = agentSeen ? '\\k<agent>' : '(?<agent>.+?)'
          agentSeen = true
          return group
        }
        return name === 'detail' ? '(?<model>.+?)' : '.+?'
      }
    )
    return new RegExp(`^${source}$`)
  }
)

export function readLegacyAutomationModelFailure(
  error: string
): { agent?: string; model?: string } | null {
  for (const sentence of LEGACY_MODEL_SENTENCES) {
    const groups = sentence.exec(error)?.groups
    if (groups) {
      const { agent, model } = groups
      return {
        agent: agent === AGENT_SESSION_FAILURE_COPY.theAgent ? undefined : agent,
        model: model === AGENT_SESSION_FAILURE_COPY.selectedModel ? undefined : model
      }
    }
  }
  return null
}
