import { parseOrcaSessionAddress } from '../../agent-session/identity/orca-session-address'

export type OrchestrationAgentReference = {
  label: string
  address: string
  hostKey: string
  /** A chat or terminal picked under `@`; absent for a crew agent, which gets mail. */
  kind?: AgentReferenceKind
  /** A terminal agent's `orca_session_id:` address, so the note can page its transcript. */
  session?: string
  /** The agent's logo on its composer pill; never part of the sent text. */
  agentType?: string
}

export type AgentReferenceKind = 'chat' | 'terminal'

export function isAgentReferenceKind(value: unknown): value is AgentReferenceKind {
  return value === 'chat' || value === 'terminal'
}

export function isPublicOrchestrationAddress(address: string): boolean {
  return (
    /^(?:term_[a-zA-Z0-9_-]+|(?:dispatch|run):[a-zA-Z0-9_-]+)$/.test(address) ||
    parseOrcaSessionAddress(address) !== null
  )
}

export function printableAgentLabel(label: string): string {
  return [...label.replace(/[\r\n\u2028\u2029]/g, ' ')]
    .filter(
      (char) =>
        char.charCodeAt(0) >= 32 && !(char.charCodeAt(0) >= 127 && char.charCodeAt(0) <= 159)
    )
    .join('')
}

// Every printed reference carries this; a draft without it holds no agent reference.
const AGENT_REFERENCE_MARK = ' (Orca agent '

export function mayHoldAgentReferences(text: string): boolean {
  return text.includes(AGENT_REFERENCE_MARK)
}

export function agentReferenceToken(reference: OrchestrationAgentReference): string {
  return `@${reference.label}${AGENT_REFERENCE_MARK}${reference.address})`
}

/** The routing line a sent message ends with, one per mentioned agent, chat or terminal. */
export function agentReferenceNote(
  label: string,
  address: string,
  kind?: AgentReferenceKind,
  session?: string
): string {
  const send = `orca orchestration send --to ${address} --subject "<topic>" --body "<message>"`
  if (kind === 'chat') {
    return `[Orca chat "${label}": ${address} — read it with orca agent read ${address}, and message it with ${send}]`
  }
  if (kind === 'terminal') {
    return `[Orca terminal "${label}": ${address} — read it with orca terminal read --terminal ${address}, ${session ? `page its agent's transcript with orca agent read ${session}, ` : ''}and type into it with orca terminal send --terminal ${address} --text "<text>" --enter]`
  }
  return `[Orca agent "${label}": ${address} — message it with ${send}]`
}

export function terminalAgentReference(reference: OrchestrationAgentReference): string | null {
  return isPublicOrchestrationAddress(reference.address)
    ? `${printableAgentLabel(reference.label)}${AGENT_REFERENCE_MARK}${reference.address}) `
    : null
}
