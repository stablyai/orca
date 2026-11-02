import { parseOrcaSessionAddress } from './orca-session-address'

export type OrchestrationAgentReference = { label: string; address: string; hostKey: string }

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

/** The routing line a sent message ends with, one per mentioned agent. */
export function agentReferenceNote(label: string, address: string): string {
  return `[Orca agent "${label}": ${address} — message it with orca orchestration send --to ${address}]`
}

const TRAILING_NOTES =
  /\n\n(?:\[Orca agent "(?:[^"\\]|\\.)*": (\S+) — message it with orca orchestration send --to \1\](?:\n|$))+$/

/** The routing lines (with their blank line) that end `text`; '' when it has none. */
export function trailingAgentReferenceNotes(text: string): string {
  return TRAILING_NOTES.exec(text)?.[0] ?? ''
}

export function terminalAgentReference(reference: OrchestrationAgentReference): string | null {
  return isPublicOrchestrationAddress(reference.address)
    ? `${printableAgentLabel(reference.label)}${AGENT_REFERENCE_MARK}${reference.address}) `
    : null
}
