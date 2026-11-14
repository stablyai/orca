import type { AppState } from '../types'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { isRemovedRuntimeHostId } from './removed-runtime-host-rows'
import { getEnvironmentSshStateGeneration } from '../slices/ssh/runtime-environment-ssh'
import { getRuntimeTargetHostId } from '../../runtime/rpc/targets/runtime-client-target'
import type { HostIdentityFence } from '../../runtime/rpc/environment-revisions/host-identity-fence'
import {
  captureHostIdentityFence,
  isHostIdentityFenceCurrent
} from '../../runtime/rpc/environment-revisions/host-identity-fence'

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

async function listRuntimeEnvironmentsForAllHostLoad(): Promise<{ id: string }[] | null> {
  try {
    return (await window.api.runtimeEnvironments.list()) ?? []
  } catch (err) {
    console.warn('Failed to list runtime environments for all-host load:', err)
    return null
  }
}

/** Claim each runtime fence before listing; stale loads claim none and callers own settlement. */
export async function loadRuntimeHostCatalogs(
  get: CatalogFenceStore,
  kind: HostCatalogKind,
  load: (
    target: Extract<RuntimeClientTarget, { kind: 'environment' }>,
    fence: HostCatalogFence
  ) => Promise<void>,
  isCurrentLoad: () => boolean = () => true,
  /** Called only when the environment list itself answered, so absence from it is authoritative. */
  onListed?: (environmentIds: readonly string[]) => void
): Promise<void> {
  const listed = await listRuntimeEnvironmentsForAllHostLoad()
  if (!isCurrentLoad()) {
    return
  }
  const environments = listed ?? []
  if (listed) {
    onListed?.(listed.map((environment) => environment.id))
  }
  await Promise.all(
    environments.map((environment) => {
      const target = { kind: 'environment' as const, environmentId: environment.id }
      return load(target, claimHostCatalogFence(get, kind, target))
    })
  )
}
