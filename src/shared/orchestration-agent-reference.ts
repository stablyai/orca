import { parseOrcaSessionAddress } from './orca-session-address'

export function isPublicOrchestrationAddress(address: string): boolean {
  return (
    /^(?:term_[a-zA-Z0-9_-]+|(?:dispatch|run):[a-zA-Z0-9_-]+)$/.test(address) ||
    parseOrcaSessionAddress(address) !== null
  )
}
