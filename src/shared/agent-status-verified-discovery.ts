import type {
  AgentSessionExecutionClaim,
  AgentSessionOwnerBinding,
  AgentSessionSurfaceBinding
} from './agent-session-host-authority'
import {
  isAgentSessionExecutionClaim,
  isAgentSessionSurfaceBinding
} from './agent-session-host-authority'
import type { AgentProviderSessionMetadata, ResumableTuiAgent } from './agent-session-resume'
import type { RemoteForegroundEvidence } from './foreground-process-evidence'
import {
  parseVerifiedAgentDiscovery,
  validProcessId,
  validProcessMarker
} from './agent-status-discovery-validation'
import { recognizeAgentProcess } from './agent-process-recognition'
import type { ClaimedAgentPtyOwnerRegistry } from './claimed-agent-pty-owner'
import type { PtyIncarnationId } from './pty-incarnation'
import { isPtyIncarnationId } from './pty-incarnation'

/** A process identity proven by the execution host, not by a pane label or cwd. */
export type VerifiedAgentDiscovery = {
  claim: AgentSessionExecutionClaim
  surface: AgentSessionSurfaceBinding
  evidence: RemoteForegroundEvidence
  providerIdentity: {
    agent: ResumableTuiAgent
    source: 'provider-session'
    session: AgentProviderSessionMetadata
    observation: {
      authorityId: string
      incarnation: number
      revision: number
      process: { pid: number; startTime: string }
    }
  }
  ancestry: {
    /** The final parent in the host-owned process chain. */
    parent: { pid: number; startTime: string }
    /** Every entry starts at the PTY shell and ends at `parent`. */
    chain: readonly { pid: number; startTime: string }[]
    relation: 'direct-child' | 'descendant' | 'multiplexer-child' | 'automation-child'
  }
  process: {
    pid: number
    startTime: string
    parentPid: number
  }
}

export type VerifiedAgentDiscoveryAdmission =
  | {
      admitted: true
      disposition: 'created' | 'adopted'
      owner: AgentSessionOwnerBinding
    }
  | {
      admitted: false
      verdict: 'unverifiable' | 'exited'
      reason: string
    }

const MAX_REASON_LENGTH = 256

export function verifiedAgentProviderIdentitiesEqual(
  left: VerifiedAgentDiscovery['providerIdentity'],
  right: VerifiedAgentDiscovery['providerIdentity'] | null
): boolean {
  return Boolean(
    right &&
    left.agent === right.agent &&
    left.session.key === right.session.key &&
    left.session.id === right.session.id &&
    left.session.transcriptPath === right.session.transcriptPath &&
    left.observation.authorityId === right.observation.authorityId &&
    left.observation.incarnation === right.observation.incarnation &&
    left.observation.revision === right.observation.revision &&
    left.observation.process.pid === right.observation.process.pid &&
    left.observation.process.startTime === right.observation.process.startTime
  )
}

function invalid(reason: string): VerifiedAgentDiscoveryAdmission {
  return {
    admitted: false,
    verdict: 'unverifiable',
    reason: reason.slice(0, MAX_REASON_LENGTH)
  }
}

function validateDiscovery(discoveryValue: unknown): VerifiedAgentDiscoveryAdmission | null {
  const discovery = parseVerifiedAgentDiscovery(discoveryValue)
  if (!discovery) {
    return invalid('discovery_shape_invalid')
  }
  if (!isAgentSessionExecutionClaim(discovery.claim)) {
    return invalid('claim_invalid')
  }
  if (!isAgentSessionSurfaceBinding(discovery.surface)) {
    return invalid('surface_invalid')
  }
  const evidence = discovery.evidence
  if (evidence.verdict !== 'live') {
    return {
      admitted: false,
      verdict: evidence.verdict,
      reason: evidence.verdict === 'exited' ? evidence.reason : evidence.reason
    }
  }
  if (!isPtyIncarnationId(evidence.ptyIncarnationId) || !validProcessMarker(evidence.ptyId)) {
    return invalid('pty_identity_missing')
  }
  if (discovery.surface.terminalHandle.length === 0) {
    return invalid('terminal_handle_missing')
  }
  if (
    !validProcessMarker(evidence.authorityGeneration) ||
    !Number.isSafeInteger(evidence.observationEpoch) ||
    evidence.observationEpoch < 0 ||
    !Number.isSafeInteger(evidence.capturedAgeMs) ||
    evidence.capturedAgeMs < 0
  ) {
    return invalid('host_observation_invalid')
  }
  const fence = evidence.fence
  if (fence.platform !== 'posix') {
    return invalid('process_fence_missing')
  }
  const fencedProcess = fence.process
  if (
    !validProcessId(fence.shellPid) ||
    !validProcessMarker(fence.shellStartTime) ||
    !validProcessMarker(fence.tty) ||
    !validProcessId(fence.foregroundPgid) ||
    !fencedProcess ||
    !validProcessId(fencedProcess.pid) ||
    !validProcessMarker(fencedProcess.startTime)
  ) {
    return invalid('process_fence_incomplete')
  }
  if (
    !validProcessId(discovery.process.pid) ||
    discovery.process.pid !== fencedProcess.pid ||
    !validProcessMarker(discovery.process.startTime) ||
    discovery.process.startTime !== fencedProcess.startTime ||
    !validProcessId(discovery.process.parentPid)
  ) {
    return invalid('process_incarnation_mismatch')
  }
  const chain = discovery.ancestry.chain
  if (
    !Array.isArray(chain) ||
    chain.length === 0 ||
    !chain.every((entry) => validProcessId(entry.pid) && validProcessMarker(entry.startTime)) ||
    chain[0]?.pid !== fence.shellPid ||
    chain[0]?.startTime !== fence.shellStartTime ||
    chain.at(-1)?.pid !== discovery.ancestry.parent.pid ||
    chain.at(-1)?.startTime !== discovery.ancestry.parent.startTime ||
    discovery.process.parentPid !== discovery.ancestry.parent.pid ||
    ((discovery.ancestry.relation === 'multiplexer-child' ||
      discovery.ancestry.relation === 'automation-child' ||
      discovery.ancestry.relation === 'descendant') &&
      chain.length < 2) ||
    !['direct-child', 'descendant', 'multiplexer-child', 'automation-child'].includes(
      discovery.ancestry.relation
    )
  ) {
    return invalid('ancestry_proof_incomplete')
  }
  const processIdentity = recognizeAgentProcess(evidence.processName)
  if (!processIdentity || processIdentity.agent !== discovery.providerIdentity.agent) {
    return invalid('provider_identity_mismatch')
  }
  if (!discovery.providerIdentity.session || discovery.providerIdentity.session.id.length === 0) {
    return invalid('provider_session_identity_missing')
  }
  if (discovery.claim.agent !== discovery.providerIdentity.agent) {
    return invalid('claim_provider_mismatch')
  }
  return null
}

/** Runtime boundary check for an optional process-inventory field. */
export function isVerifiedAgentDiscovery(value: unknown): value is VerifiedAgentDiscovery {
  return validateDiscovery(value) === null
}

export function cloneVerifiedAgentDiscovery(
  discovery: VerifiedAgentDiscovery
): VerifiedAgentDiscovery {
  return {
    ...discovery,
    claim: {
      ...discovery.claim
    },
    surface: {
      ...discovery.surface
    },
    evidence: {
      ...discovery.evidence,
      ...(discovery.evidence.verdict === 'live'
        ? {
            fence:
              discovery.evidence.fence.platform === 'posix'
                ? {
                    ...discovery.evidence.fence,
                    ...(discovery.evidence.fence.process
                      ? { process: { ...discovery.evidence.fence.process } }
                      : {})
                  }
                : {
                    ...discovery.evidence.fence,
                    ...(discovery.evidence.fence.process
                      ? { process: { ...discovery.evidence.fence.process } }
                      : {})
                  }
          }
        : {})
    },
    providerIdentity: {
      ...discovery.providerIdentity,
      session: { ...discovery.providerIdentity.session },
      observation: {
        ...discovery.providerIdentity.observation,
        process: { ...discovery.providerIdentity.observation.process }
      }
    },
    ancestry: {
      ...discovery.ancestry,
      parent: { ...discovery.ancestry.parent },
      chain: discovery.ancestry.chain.map((entry) => ({ ...entry }))
    },
    process: { ...discovery.process }
  }
}

/**
 * Admit an execution discovered outside Orca's launch path through the same owner transaction as
 * fresh launches. The callback is an adoption hook: it never starts a process. All identity and
 * ancestry checks happen before the registry can mint a status binding.
 */
export async function admitVerifiedAgentDiscovery(args: {
  owners: ClaimedAgentPtyOwnerRegistry
  discovery: VerifiedAgentDiscovery
  isLive?: (ptyId: string, incarnationId: PtyIncarnationId) => boolean | Promise<boolean>
}): Promise<VerifiedAgentDiscoveryAdmission> {
  const validation = validateDiscovery(args.discovery)
  if (validation) {
    return validation
  }
  const { discovery } = args
  const existing = args.owners.find(discovery.claim)
  if (
    existing &&
    (existing.ptyId !== discovery.evidence.ptyId ||
      existing.surface.terminalHandle !== discovery.surface.terminalHandle)
  ) {
    return invalid('owner_surface_conflict')
  }
  const foreignManagedOwner = args.owners
    .listForPty(discovery.evidence.ptyId)
    .find(
      (owner) =>
        owner.discoveryProcess === undefined &&
        owner.claim.identityDigest !== discovery.claim.identityDigest
    )
  if (foreignManagedOwner) {
    return invalid('managed_owner_present')
  }
  try {
    const result = await args.owners.ensure({
      claim: discovery.claim,
      surface: discovery.surface,
      discoveryProcess: {
        ptyIncarnationId: discovery.evidence.ptyIncarnationId,
        pid: discovery.process.pid,
        startTime: discovery.process.startTime,
        authorityGeneration: discovery.evidence.authorityGeneration,
        observationEpoch: discovery.evidence.observationEpoch,
        providerObservation: {
          ...discovery.providerIdentity.observation,
          process: { ...discovery.providerIdentity.observation.process }
        }
      },
      replaceDiscoveredPtyId: discovery.evidence.ptyId,
      spawn: async () => ({ ptyId: discovery.evidence.ptyId, disposition: 'adopted' as const }),
      isLive: async (owner) => {
        if (owner.ptyId !== discovery.evidence.ptyId) {
          return false
        }
        return args.isLive
          ? await args.isLive(owner.ptyId, discovery.evidence.ptyIncarnationId)
          : true
      }
    })
    return {
      admitted: true,
      disposition: result.disposition,
      owner: result.owner
    }
  } catch (error) {
    return invalid(error instanceof Error ? error.message : 'owner_admission_failed')
  }
}
