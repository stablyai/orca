import type { HostRoute } from '../targets/runtime-client-target'
import { parseExecutionHostId } from '../../../../../shared/execution-host'
import {
  getRuntimeEnvironmentRevision,
  resolveContinuedRuntimeEnvironmentRevision
} from './runtime-environment-revision'
import { getEnvironmentSshTargetConnectionGeneration } from '../../../store/slices/ssh/runtime-environment-ssh'
import { getLocalSshTargetConnectionGeneration } from '../../../store/slices/ssh/create-ssh-slice'
import { getRuntimeEnvironmentConnectionGeneration } from '../../../store/slices/runtime-status/runtime-status-connection-generation'

/** Fence by pairing/runtime incarnation and SSH target generation, not unrelated catalog/connection churn. */
export type HostIdentityFence = {
  route: HostRoute
  pairingRevision: number | undefined
  runtimeConnectionGeneration: number | null
  sshTargetConnectionGeneration: number | null
}

function sshTargetConnectionGeneration(route: HostRoute): number | null {
  const place = parseExecutionHostId(route.at)
  if (place?.kind !== 'ssh') {
    return null
  }
  return route.target.kind === 'environment'
    ? getEnvironmentSshTargetConnectionGeneration(route.target.environmentId, place.targetId)
    : getLocalSshTargetConnectionGeneration(place.targetId)
}

export function captureHostIdentityFence(route: HostRoute): HostIdentityFence {
  const environmentId = route.target.kind === 'environment' ? route.target.environmentId : null
  return {
    route,
    pairingRevision: environmentId ? getRuntimeEnvironmentRevision(environmentId) : undefined,
    runtimeConnectionGeneration: environmentId
      ? getRuntimeEnvironmentConnectionGeneration(environmentId)
      : null,
    sshTargetConnectionGeneration: sshTargetConnectionGeneration(route)
  }
}

/** The same machine, across reconnects: only a re-pair to a different machine changes it. */
export function isHostIdentityContinued(fence: HostIdentityFence): boolean {
  const { route } = fence
  if (route.target.kind !== 'environment') {
    return true
  }
  const { environmentId } = route.target
  // Why continuity: a re-pair proven to be the same machine keeps the identity.
  return (
    resolveContinuedRuntimeEnvironmentRevision(environmentId, fence.pairingRevision) ===
    getRuntimeEnvironmentRevision(environmentId)
  )
}

export function isHostIdentityFenceCurrent(fence: HostIdentityFence): boolean {
  const { route } = fence
  return (
    isHostIdentityContinued(fence) &&
    (route.target.kind !== 'environment' ||
      getRuntimeEnvironmentConnectionGeneration(route.target.environmentId) ===
        fence.runtimeConnectionGeneration) &&
    sshTargetConnectionGeneration(route) === fence.sshTargetConnectionGeneration
  )
}
