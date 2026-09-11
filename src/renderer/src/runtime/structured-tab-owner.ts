// The one derivation of "which host does this chat tab belong to".
//
// The owner is launch-scoped but a pane is session-scoped, so re-reading the worktree's current
// runtime owner on every render pointed an open pane at whatever machine answered to that id at
// that moment. The tab carries the stamp instead, and every surface that renders, activates or
// closes a structured session reads it from here.

import { useMemo } from 'react'
import { parseExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import type { Tab } from '../../../shared/tab-types'
import { getRuntimeEnvironmentRevision } from './runtime-environment-revision'
import { runtimeTargetForExecutionHostId, type RuntimeClientTarget } from './runtime-client-target'
import {
  structuredAgentSessionOwnerMatchesPairing,
  structuredAgentSessionOwnerTarget,
  type StructuredAgentSessionOwner
} from './structured-agent-session-owner'

export type StructuredTabOwnerStamp = Pick<Tab, 'executionHostId' | 'runtimeOwnerPairingRevision'>

export type StructuredTabOwnerBinding = {
  owner: StructuredAgentSessionOwner
  target: RuntimeClientTarget
  /** True only for a stamped owner whose environment has been re-paired since: serve the cached
   *  transcript and refuse mutations rather than rebinding to the id's new occupant. */
  ownerPairingStale: boolean
}

const LOCAL_OWNER: StructuredAgentSessionOwner = { kind: 'local' }
const LOCAL_TARGET: RuntimeClientTarget = { kind: 'local' }

/** Null when the tab predates stamping; callers fall back to the legacy worktree derivation. */
export function structuredTabOwnerFromStamp(
  stamp: StructuredTabOwnerStamp | null | undefined
): StructuredAgentSessionOwner | null {
  const parsed = parseExecutionHostId(stamp?.executionHostId)
  if (!parsed) {
    return null
  }
  const target = runtimeTargetForExecutionHostId(parsed.id)
  if (target?.kind !== 'environment') {
    // An `ssh:` host has no client RPC path of its own, so it reads as local like every other stage.
    return LOCAL_OWNER
  }
  const pairingRevision = stamp?.runtimeOwnerPairingRevision
  return {
    kind: 'environment',
    environmentId: target.environmentId,
    ...(pairingRevision === undefined ? {} : { pairingRevision })
  }
}

export function structuredTabOwnerBinding(
  stamp: StructuredTabOwnerStamp | null | undefined,
  fallbackRuntimeEnvironmentId: string | null | undefined
): StructuredTabOwnerBinding {
  const stamped = structuredTabOwnerFromStamp(stamp)
  if (!stamped) {
    // Legacy tab: keep the pre-stamp behaviour exactly, including never reading as cached.
    const environmentId = fallbackRuntimeEnvironmentId?.trim()
    return environmentId
      ? {
          owner: { kind: 'environment', environmentId },
          target: { kind: 'environment', environmentId },
          ownerPairingStale: false
        }
      : { owner: LOCAL_OWNER, target: LOCAL_TARGET, ownerPairingStale: false }
  }
  return {
    owner: stamped,
    target: structuredAgentSessionOwnerTarget(stamped),
    ownerPairingStale: !structuredAgentSessionOwnerMatchesPairing(stamped)
  }
}

/**
 * The stamp a freshly mirrored chat tab carries. Pinned once: a later snapshot from the same or a
 * replacement publisher must not move an open pane's owner.
 */
export function stampStructuredTabOwner(
  existing: StructuredTabOwnerStamp | null | undefined,
  ownerHostId: ExecutionHostId
): StructuredTabOwnerStamp {
  if (existing?.executionHostId) {
    const pinnedRevision = existing.runtimeOwnerPairingRevision
    return {
      executionHostId: existing.executionHostId,
      ...(pinnedRevision === undefined ? {} : { runtimeOwnerPairingRevision: pinnedRevision })
    }
  }
  const parsed = parseExecutionHostId(ownerHostId)
  const revision =
    parsed?.kind === 'runtime' ? getRuntimeEnvironmentRevision(parsed.environmentId) : undefined
  return {
    executionHostId: ownerHostId,
    ...(revision === undefined ? {} : { runtimeOwnerPairingRevision: revision })
  }
}

/**
 * Identity-stable binding for a rendering pane. The target is memoized because the read owner and
 * the hold are keyed on it, while staleness is re-read every render: a re-pair moves the revision
 * map without touching the tab.
 */
export function useStructuredTabOwnerBinding(
  stamp: StructuredTabOwnerStamp,
  fallbackRuntimeEnvironmentId: string | null | undefined
): StructuredTabOwnerBinding {
  const executionHostId = stamp.executionHostId
  const runtimeOwnerPairingRevision = stamp.runtimeOwnerPairingRevision
  const pinned = useMemo(
    () =>
      structuredTabOwnerBinding(
        { executionHostId, runtimeOwnerPairingRevision },
        fallbackRuntimeEnvironmentId
      ),
    [executionHostId, runtimeOwnerPairingRevision, fallbackRuntimeEnvironmentId]
  )
  const owner = pinned.owner
  return {
    ...pinned,
    ownerPairingStale:
      structuredTabOwnerFromStamp({ executionHostId, runtimeOwnerPairingRevision }) !== null &&
      !structuredAgentSessionOwnerMatchesPairing(owner)
  }
}
