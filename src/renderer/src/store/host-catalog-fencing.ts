import type { AppState } from './types'
import type { HostRoute, RuntimeClientTarget } from '../runtime/runtime-client-target'
import { parseExecutionHostId } from '../../../shared/execution-host'
import {
  getRuntimeEnvironmentRevision,
  resolveContinuedRuntimeEnvironmentRevision
} from '../runtime/runtime-environment-revision'
import { isRemovedRuntimeHostId } from './slices/stale-runtime-host-rows'
import {
  getEnvironmentSshStateGeneration,
  getEnvironmentSshTargetConnectionGeneration
} from './slices/runtime-environment-ssh'
import { getLocalSshTargetConnectionGeneration } from './slices/ssh'
import { getRuntimeEnvironmentConnectionGeneration } from './slices/runtime-status'
import { getRuntimeTargetHostId } from './runtime-target-host'

/**
 * Who answered: pairing, runtime incarnation (connection generation) and, for an SSH place, that
 * target's connection generation. Guards mutations; unrelated catalog or SSH churn never moves it.
 */
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

export function isHostIdentityFenceCurrent(fence: HostIdentityFence): boolean {
  const { route } = fence
  if (route.target.kind === 'environment') {
    const { environmentId } = route.target
    // Why continuity: a re-pair proven to be the same machine keeps the identity.
    if (
      resolveContinuedRuntimeEnvironmentRevision(environmentId, fence.pairingRevision) !==
        getRuntimeEnvironmentRevision(environmentId) ||
      getRuntimeEnvironmentConnectionGeneration(environmentId) !== fence.runtimeConnectionGeneration
    ) {
      return false
    }
  }
  return sshTargetConnectionGeneration(route) === fence.sshTargetConnectionGeneration
}

export type HostCatalogKind = 'repos' | 'project-groups' | 'folder-workspaces'

/** Identity fence plus data generations: guards reads that apply a host's catalog snapshot. */
export type HostCatalogFence = {
  key: string
  generation: number
  target: RuntimeClientTarget
  identity: HostIdentityFence
  sshStateGeneration: number | null
}

type CatalogFenceStore = () => Pick<AppState, 'removedRuntimeEnvironmentIds'>

const latestHostCatalogGenerationByStore = new WeakMap<CatalogFenceStore, Map<string, number>>()

export function claimHostCatalogFence(
  get: CatalogFenceStore,
  kind: HostCatalogKind,
  target: RuntimeClientTarget
): HostCatalogFence {
  const key = `${kind}:${getRuntimeTargetHostId(target)}`
  let generations = latestHostCatalogGenerationByStore.get(get)
  if (!generations) {
    generations = new Map()
    latestHostCatalogGenerationByStore.set(get, generations)
  }
  const generation = (generations.get(key) ?? 0) + 1
  generations.set(key, generation)
  return {
    key,
    generation,
    target,
    identity: captureHostIdentityFence({ target, at: 'local' }),
    sshStateGeneration:
      target.kind === 'environment' ? getEnvironmentSshStateGeneration(target.environmentId) : null
  }
}

export function isHostCatalogFenceCurrent(
  get: CatalogFenceStore,
  fence: HostCatalogFence
): boolean {
  if (latestHostCatalogGenerationByStore.get(get)?.get(fence.key) !== fence.generation) {
    return false
  }
  if (fence.target.kind !== 'environment') {
    return true
  }
  return (
    !isRemovedRuntimeHostId(
      getRuntimeTargetHostId(fence.target),
      get().removedRuntimeEnvironmentIds
    ) &&
    getEnvironmentSshStateGeneration(fence.target.environmentId) === fence.sshStateGeneration &&
    isHostIdentityFenceCurrent(fence.identity)
  )
}
