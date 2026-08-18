import type { AppState } from '@/store/types'
import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { hashOrcaHookScript, type OrcaHookScriptKind } from './orca-hook-trust'
import { getRuntimeEnvironmentIdForRepo } from './repo-runtime-owner'

export const NEVER_CANCEL_TRUST_CHECK = (): boolean => false

export function findHookRepo(state: AppState, repoId: string, hostId?: ExecutionHostId) {
  return hostId
    ? state.repos.find((repo) => repo.id === repoId && getRepoExecutionHostId(repo) === hostId)
    : state.repos.find((repo) => repo.id === repoId)
}

export function settingsForHookRepoOwner(
  state: AppState,
  repoId: string,
  hostId?: ExecutionHostId,
  runtimeOwnerEnvironmentId?: string | null
): AppState['settings'] {
  const parsedHost = hostId ? parseExecutionHostId(hostId) : null
  const runtimeEnvironmentId =
    runtimeOwnerEnvironmentId?.trim() ||
    (hostId
      ? parsedHost?.kind === 'runtime'
        ? parsedHost.environmentId
        : null
      : getRuntimeEnvironmentIdForRepo(state, repoId))
  return state.settings
    ? { ...state.settings, activeRuntimeEnvironmentId: runtimeEnvironmentId }
    : ({ activeRuntimeEnvironmentId: runtimeEnvironmentId } as AppState['settings'])
}

export function canUseRepoWideTrust(state: AppState, repoId: string): boolean {
  const hasDuplicateRepoId = state.repos.filter((repo) => repo.id === repoId).length > 1
  return Boolean(state.trustedOrcaHooks[repoId]?.all) && !hasDuplicateRepoId
}

export async function confirmScriptContent(
  state: AppState,
  repoId: string,
  scriptKind: OrcaHookScriptKind,
  scriptContent: string,
  hostId?: ExecutionHostId,
  isCancelled: () => boolean = NEVER_CANCEL_TRUST_CHECK
): Promise<'run' | 'skip'> {
  if (isCancelled()) {
    return 'skip'
  }
  if (canUseRepoWideTrust(state, repoId) || !scriptContent) {
    return 'run'
  }

  const contentHash = await hashOrcaHookScript(scriptContent)
  if (isCancelled()) {
    return 'skip'
  }
  const existingHash = state.trustedOrcaHooks[repoId]?.[scriptKind]?.contentHash
  if (existingHash === contentHash) {
    return 'run'
  }

  const repoName = findHookRepo(state, repoId, hostId)?.displayName ?? 'this repository'
  return new Promise<'run' | 'skip'>((resolve) => {
    state.openModal('confirm-orca-yaml-hooks', {
      repoId,
      repoName,
      scriptKind,
      scriptContent,
      contentHash,
      previouslyApproved: Boolean(existingHash),
      onResolve: (decision: 'run' | 'skip') => resolve(decision)
    })
  })
}
