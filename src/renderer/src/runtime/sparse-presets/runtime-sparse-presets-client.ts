import type { SparsePreset } from '../../../../shared/worktree/create-types'
import type { SparsePresetFailure } from '../../../../shared/worktree/creation/sparse-preset-failure'
import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import type { RuntimeClientTarget } from '../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { translate } from '@/i18n/i18n'
import { callRuntimeRpc } from '../rpc/calls/runtime-rpc-call'
import { ipcOrRuntimeTargetForHostId } from '../rpc/targets/runtime-client-target'
import { hasRuntimeRpcErrorCode } from '../../../../shared/remote-runtime/rpc/runtime-rpc-error-code'

/** A server-hosted repo's presets live in that server's store; local and SSH repos use this app's. */
function presetHostTarget(hostId: ExecutionHostId): RuntimeClientTarget {
  const target = ipcOrRuntimeTargetForHostId(hostId)
  if (!target) {
    throw new Error('The project host is unresolved.')
  }
  return target
}

export async function listRuntimeSparsePresets(
  hostId: ExecutionHostId,
  repoId: string
): Promise<SparsePreset[]> {
  const target = presetHostTarget(hostId)
  if (target.kind !== 'environment') {
    return window.api.sparsePresets.list({ repoId })
  }
  const result = await callRuntimeRpc<{ presets: SparsePreset[] }>(
    target,
    'repo.sparsePresets',
    { repo: `id:${repoId}` },
    { timeoutMs: 15_000 }
  )
  return result.presets
}

export async function saveRuntimeSparsePreset(
  hostId: ExecutionHostId,
  args: { repoId: string; id?: string; name: string; directories: string[] }
): Promise<SparsePreset | SparsePresetFailure> {
  const target = presetHostTarget(hostId)
  if (target.kind !== 'environment') {
    return window.api.sparsePresets.save(args)
  }
  const result = await callRuntimeRpc<{ preset: SparsePreset }>(
    target,
    'repo.saveSparsePreset',
    {
      repo: `id:${args.repoId}`,
      ...(args.id ? { id: args.id } : {}),
      name: args.name,
      directories: args.directories
    },
    { timeoutMs: 15_000 }
  )
  return result.preset
}

export async function removeRuntimeSparsePreset(
  hostId: ExecutionHostId,
  args: { repoId: string; presetId: string }
): Promise<void> {
  const target = presetHostTarget(hostId)
  if (target.kind !== 'environment') {
    await window.api.sparsePresets.remove(args)
    return
  }
  try {
    await callRuntimeRpc(
      target,
      'repo.removeSparsePreset',
      { repo: `id:${args.repoId}`, presetId: args.presetId },
      { timeoutMs: 15_000 }
    )
  } catch (error) {
    // Servers older than repo.removeSparsePreset can list and save presets but not remove them.
    if (hasRuntimeRpcErrorCode(error, 'method_not_found')) {
      throw new Error(
        translate(
          'sparsePreset.updateServerToRemove',
          'Update Orca on this project’s server to remove its presets.'
        )
      )
    }
    throw error
  }
}
