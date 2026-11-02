import type { AppState } from '../types'
import { FOLDER_WORKSPACE_PATH_STATUS_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import type { FolderWorkspacePathStatus } from '../../../../shared/folder-workspace-path-status'
import {
  assertRuntimeEnvironmentCapability,
  callRuntimeRpc
} from '../../runtime/runtime-rpc-client'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { translate } from '@/i18n/i18n'

export function getRuntimeEnvironmentDisplayName(state: AppState, environmentId: string): string {
  const environment = state.runtimeEnvironments.find((entry) => entry.id === environmentId)
  return environment?.name || environmentId
}

export async function fetchRuntimeAddProjectPathStatus(args: {
  target: Extract<RuntimeClientTarget, { kind: 'environment' }>
  path: string
}): Promise<FolderWorkspacePathStatus | null> {
  await assertRuntimeEnvironmentCapability(
    args.target.environmentId,
    FOLDER_WORKSPACE_PATH_STATUS_RUNTIME_CAPABILITY,
    translate(
      'auto.store.slices.repos.2975400634',
      'Update Orca server to open non-Git folders on this runtime.'
    ),
    15_000
  )
  try {
    const { status } = await callRuntimeRpc<{ status: FolderWorkspacePathStatus }>(
      args.target,
      'folderWorkspace.getPathStatus',
      { scope: 'path', path: args.path },
      { timeoutMs: 15_000 }
    )
    return status
  } catch (err) {
    console.warn('Failed to check runtime folder path status:', err)
    return null
  }
}
