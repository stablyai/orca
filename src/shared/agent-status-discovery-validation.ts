import {
  isAgentSessionExecutionClaim,
  isAgentSessionSurfaceBinding
} from './agent-session-host-authority'
import { isRemoteForegroundEvidence } from './foreground-process-evidence'
import { isResumableTuiAgent, normalizeAgentProviderSession } from './agent-session-resume'
import type { VerifiedAgentDiscovery } from './agent-status-verified-discovery'

function validProcessMarker(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
}

function validProcessId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

type DiscoveryCandidate = {
  claim: unknown
  surface: unknown
  evidence: unknown
  providerIdentity: unknown
  ancestry: unknown
  process: unknown
}

function isDiscoveryCandidate(value: unknown): value is DiscoveryCandidate {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  return (
    'claim' in value &&
    'surface' in value &&
    'evidence' in value &&
    'providerIdentity' in value &&
    'ancestry' in value &&
    'process' in value
  )
}

function parseProviderIdentity(value: unknown): VerifiedAgentDiscovery['providerIdentity'] | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }
  if (
    !('agent' in value) ||
    !isResumableTuiAgent(value.agent) ||
    !('source' in value) ||
    value.source !== 'provider-session' ||
    !('session' in value) ||
    !('observation' in value) ||
    typeof value.observation !== 'object' ||
    value.observation === null ||
    Array.isArray(value.observation) ||
    !('authorityId' in value.observation) ||
    !validProcessMarker(value.observation.authorityId) ||
    !('incarnation' in value.observation) ||
    !Number.isSafeInteger(value.observation.incarnation) ||
    Number(value.observation.incarnation) < 0 ||
    !('revision' in value.observation) ||
    !Number.isSafeInteger(value.observation.revision) ||
    Number(value.observation.revision) <= 0 ||
    !('process' in value.observation) ||
    typeof value.observation.process !== 'object' ||
    value.observation.process === null ||
    Array.isArray(value.observation.process) ||
    !('pid' in value.observation.process) ||
    !Number.isSafeInteger(value.observation.process.pid) ||
    Number(value.observation.process.pid) <= 0 ||
    !('startTime' in value.observation.process) ||
    !validProcessMarker(value.observation.process.startTime)
  ) {
    return null
  }
  const session = normalizeAgentProviderSession(value.session)
  return session
    ? {
        agent: value.agent,
        source: value.source,
        session,
        observation: {
          authorityId: value.observation.authorityId,
          incarnation: Number(value.observation.incarnation),
          revision: Number(value.observation.revision),
          process: {
            pid: Number(value.observation.process.pid),
            startTime: value.observation.process.startTime
          }
        }
      }
    : null
}

function parseAncestry(value: unknown): VerifiedAgentDiscovery['ancestry'] | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }
  if (!('parent' in value) || !('chain' in value) || !('relation' in value)) {
    return null
  }
  if (
    typeof value.parent !== 'object' ||
    value.parent === null ||
    Array.isArray(value.parent) ||
    !('pid' in value.parent) ||
    !('startTime' in value.parent) ||
    !validProcessId(value.parent.pid) ||
    !validProcessMarker(value.parent.startTime) ||
    !Array.isArray(value.chain) ||
    !value.chain.every(
      (entry) =>
        typeof entry === 'object' &&
        entry !== null &&
        !Array.isArray(entry) &&
        'pid' in entry &&
        'startTime' in entry &&
        validProcessId(entry.pid) &&
        validProcessMarker(entry.startTime)
    ) ||
    (value.relation !== 'direct-child' &&
      value.relation !== 'descendant' &&
      value.relation !== 'multiplexer-child' &&
      value.relation !== 'automation-child')
  ) {
    return null
  }
  return {
    parent: { pid: value.parent.pid, startTime: value.parent.startTime },
    chain: value.chain.map((entry) => ({ pid: entry.pid, startTime: entry.startTime })),
    relation: value.relation
  }
}

function parseProcess(value: unknown): VerifiedAgentDiscovery['process'] | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }
  if (
    !('pid' in value) ||
    !('startTime' in value) ||
    !('parentPid' in value) ||
    !validProcessId(value.pid) ||
    !validProcessMarker(value.startTime) ||
    !validProcessId(value.parentPid)
  ) {
    return null
  }
  return { pid: value.pid, startTime: value.startTime, parentPid: value.parentPid }
}

/** Parse a process-inventory candidate before it reaches owner admission. */
export function parseVerifiedAgentDiscovery(value: unknown): VerifiedAgentDiscovery | null {
  if (!isDiscoveryCandidate(value)) {
    return null
  }
  if (!isAgentSessionExecutionClaim(value.claim) || !isAgentSessionSurfaceBinding(value.surface)) {
    return null
  }
  if (!isRemoteForegroundEvidence(value.evidence)) {
    return null
  }
  const providerIdentity = parseProviderIdentity(value.providerIdentity)
  const ancestry = parseAncestry(value.ancestry)
  const process = parseProcess(value.process)
  if (!providerIdentity || !ancestry || !process) {
    return null
  }
  return {
    claim: value.claim,
    surface: value.surface,
    evidence: value.evidence,
    providerIdentity,
    ancestry,
    process
  }
}

export { validProcessId, validProcessMarker }
