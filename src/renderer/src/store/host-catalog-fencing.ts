import type { AppState } from './types'
import type { RuntimeClientTarget } from '../runtime/runtime-rpc-client'
import { isRemovedRuntimeHostId } from './slices/stale-runtime-host-rows'
import { getEnvironmentSshStateGeneration } from './slices/runtime-environment-ssh'
import { getRuntimeEnvironmentConnectionGeneration } from './slices/runtime-status'
import { getRuntimeTargetHostId } from './runtime-target-host'

export type HostCatalogKind = 'project-groups' | 'folder-workspaces'

export type HostCatalogFence = {
  key: string
  generation: number
  target: RuntimeClientTarget
  sshStateGeneration: number | null
  runtimeConnectionGeneration: number | null
}

const latestHostCatalogGenerationByStore = new WeakMap<() => AppState, Map<string, number>>()

export function claimHostCatalogFence(
  get: () => AppState,
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
    sshStateGeneration:
      target.kind === 'environment' ? getEnvironmentSshStateGeneration(target.environmentId) : null,
    runtimeConnectionGeneration:
      target.kind === 'environment'
        ? getRuntimeEnvironmentConnectionGeneration(target.environmentId)
        : null
  }
}

export function isHostCatalogFenceCurrent(get: () => AppState, fence: HostCatalogFence): boolean {
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
    getRuntimeEnvironmentConnectionGeneration(fence.target.environmentId) ===
      fence.runtimeConnectionGeneration
  )
}
