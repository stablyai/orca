import { parseExecutionHostId } from '../../../shared/execution-host'
import { getRuntimeEnvironmentRevision } from './runtime-environment-revision'
import { runtimeTargetForExecutionHostId, type RuntimeClientTarget } from './runtime-client-target'
import { callStructuredAgentSession } from './structured-agent-session-client'
import { LOCAL_STRUCTURED_SESSION_OWNER } from './local-structured-session-tabs-sync/snapshot-apply'
import type { WebSessionIntentOwner } from './web-session-intent-owner'

/**
 * The host a structured session belongs to, pinned once at launch. The pairing revision rides along
 * because an environment id is reused across re-pairings: the id alone would still name the host
 * after it became a different machine.
 */
export type StructuredAgentSessionOwner =
  | { kind: 'local' }
  | { kind: 'environment'; environmentId: string; pairingRevision?: number }

const LOCAL_OWNER: StructuredAgentSessionOwner = { kind: 'local' }

/** Synchronous by contract: a revision read after an await can already name a re-paired host. */
export function captureStructuredAgentSessionOwner(
  target: RuntimeClientTarget | null | undefined
): StructuredAgentSessionOwner {
  if (target?.kind !== 'environment') {
    return LOCAL_OWNER
  }
  const environmentId = target.environmentId
  const pairingRevision = getRuntimeEnvironmentRevision(environmentId)
  return {
    kind: 'environment',
    environmentId,
    ...(pairingRevision === undefined ? {} : { pairingRevision })
  }
}

/** An `ssh:` host has no client RPC path of its own, so it pins no environment. */
export function captureStructuredAgentSessionOwnerForHost(
  hostId: string | null | undefined
): StructuredAgentSessionOwner {
  const parsed = parseExecutionHostId(hostId)
  return captureStructuredAgentSessionOwner(
    parsed ? runtimeTargetForExecutionHostId(parsed.id) : null
  )
}

export function structuredAgentSessionOwnerTarget(
  owner: StructuredAgentSessionOwner
): RuntimeClientTarget {
  return owner.kind === 'environment'
    ? { kind: 'environment', environmentId: owner.environmentId }
    : { kind: 'local' }
}

/** False once the owner's environment has been re-paired since capture. */
export function structuredAgentSessionOwnerMatchesPairing(
  owner: StructuredAgentSessionOwner
): boolean {
  return (
    owner.kind === 'local' ||
    getRuntimeEnvironmentRevision(owner.environmentId) === owner.pairingRevision
  )
}

/**
 * The one RPC seam every stage of a pinned launch goes through. It addresses the owner's host and
 * carries the revision captured with it, so a re-pair between stages fails the call instead of
 * silently retargeting it at whatever machine now answers to that id.
 */
export function callStructuredAgentSessionForOwner<TResult>(
  owner: StructuredAgentSessionOwner,
  method: string,
  params?: unknown
): Promise<TResult> {
  return callStructuredAgentSession<TResult>(
    structuredAgentSessionOwnerTarget(owner),
    method,
    params,
    structuredAgentSessionOwnerCallFence(owner)
  )
}

/** The revision every call for this owner is fenced on; empty for a host with no pairing. */
export function structuredAgentSessionOwnerCallFence(owner: StructuredAgentSessionOwner): {
  expectedEnvironmentPairingRevision?: number
} {
  return owner.kind === 'environment' && owner.pairingRevision !== undefined
    ? { expectedEnvironmentPairingRevision: owner.pairingRevision }
    : {}
}

/** Focus intents are partitioned by owner, so a launch must record under the host that publishes it. */
export function structuredAgentSessionOwnerIntentKey(
  owner: StructuredAgentSessionOwner
): WebSessionIntentOwner {
  return owner.kind === 'environment'
    ? {
        environmentId: owner.environmentId,
        ...(owner.pairingRevision === undefined ? {} : { pairingRevision: owner.pairingRevision })
      }
    : { environmentId: LOCAL_STRUCTURED_SESSION_OWNER }
}
