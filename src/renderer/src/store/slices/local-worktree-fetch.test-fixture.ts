import type { AppState } from '@/store/types'
import type { DirectSshWorktreeFetchOptions, WorktreeFetchOptions } from './worktree-helpers'
import type { HostQualifiedDetectedWorktreeResult } from '../../../../shared/detected-worktree-provider-contract'

export function localWorktreeFetch(result: Promise<boolean>): AppState['fetchWorktrees'] {
  function fetchWorktrees(
    repoId: string,
    options: DirectSshWorktreeFetchOptions
  ): Promise<HostQualifiedDetectedWorktreeResult>
  function fetchWorktrees(repoId: string, options?: WorktreeFetchOptions): Promise<boolean>
  function fetchWorktrees(
    _repoId: string,
    options?: WorktreeFetchOptions
  ): Promise<boolean | HostQualifiedDetectedWorktreeResult> {
    return options && 'directSshAuthority' in options
      ? Promise.reject(new Error('This fixture serves only the local fetch overload.'))
      : result
  }
  return fetchWorktrees
}
