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

export function agentReferenceToken(reference: OrchestrationAgentReference): string {
  return `@${reference.label} (Orca agent ${reference.address})`
}

export function terminalAgentReference(reference: OrchestrationAgentReference): string | null {
  return isPublicOrchestrationAddress(reference.address)
    ? `${printableAgentLabel(reference.label)} (Orca agent ${reference.address}) `
    : null
}
