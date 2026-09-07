import type { AppState } from '../types'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { Repo } from '../../../../shared/repo-types'
import { FOLDER_WORKSPACE_PATH_STATUS_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import type { FolderWorkspacePathStatus } from '../../../../shared/folder-workspace-path-status'
import { findRepoForHost } from '../slices/repo-host-identity'
import {
  assertRuntimeEnvironmentCapability,
  callRuntimeRpc
} from '../../runtime/runtime-rpc-client'
import type { getActiveRuntimeTarget } from '../../runtime/runtime-rpc-client'
import { translate } from '@/i18n/i18n'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId
} from '../../../../shared/execution-host'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { AddRepoPathOptions } from './repo-state'
import { getRuntimeTargetHostId } from '../runtime-target-host'

export function repoWithFetchedOwner(
  repo: Repo,
  target: ReturnType<typeof getActiveRuntimeTarget>
): Repo {
  if (target.kind === 'environment') {
    return { ...repo, executionHostId: getRuntimeTargetHostId(target) }
  }
  if (repo.connectionId) {
    return { ...repo, executionHostId: getRepoExecutionHostId(repo) }
  }
  return repo.executionHostId ? repo : { ...repo, executionHostId: LOCAL_EXECUTION_HOST_ID }
}

export function settingsForRepoOwner(
  state: Pick<AppState, 'repos' | 'settings'>,
  repoId: string,
  hostId?: ExecutionHostId
) {
  const repo = findRepoForHost(state.repos, repoId, { settings: state.settings, hostId })
  if (!repo) {
    return state.settings
  }
  if (!repo.executionHostId && !repo.connectionId) {
    return state.settings
  }
  const parsed = parseExecutionHostId(getRepoExecutionHostId(repo))
  if (parsed?.kind === 'runtime') {
    return state.settings
      ? { ...state.settings, activeRuntimeEnvironmentId: parsed.environmentId }
      : ({ activeRuntimeEnvironmentId: parsed.environmentId } as AppState['settings'])
  }
  if (
    (parsed?.kind === 'local' || parsed?.kind === 'ssh') &&
    state.settings?.activeRuntimeEnvironmentId
  ) {
    return { ...state.settings, activeRuntimeEnvironmentId: null }
  }
  return state.settings
}

export function getAddRepoPathRouteSettings(
  options: AddRepoPathOptions | undefined,
  fallbackSettings: GlobalSettings | null
): Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined {
  return options && 'runtimeEnvironmentId' in options
    ? { activeRuntimeEnvironmentId: options.runtimeEnvironmentId ?? null }
    : fallbackSettings
}

export function getRuntimeEnvironmentDisplayName(state: AppState, environmentId: string): string {
  const environment = state.runtimeEnvironments.find((entry) => entry.id === environmentId)
  return environment?.name || environmentId
}

export async function fetchRuntimeAddProjectPathStatus(args: {
  target: Extract<ReturnType<typeof getActiveRuntimeTarget>, { kind: 'environment' }>
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
