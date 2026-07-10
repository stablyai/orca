import { useAppStore } from '@/store'
import { CLIENT_PLATFORM } from '@/lib/new-workspace'
import { isWslUncPath } from '../../../shared/wsl-paths'
import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'

export function getResumeLaunchPlatform(worktreeId: string): NodeJS.Platform {
  const state = useAppStore.getState()
  const worktree = state.getKnownWorktreeById(worktreeId)
  const repo = worktree ? state.repos.find((entry) => entry.id === worktree.repoId) : null
  const projectRuntime = getLocalProjectExecutionRuntimeContext(state, worktreeId)
  if (projectRuntime?.status === 'repair-required') {
    return projectRuntime.repair.preferredRuntime.kind === 'wsl' ? 'linux' : CLIENT_PLATFORM
  }
  if (projectRuntime?.status === 'resolved' && projectRuntime.runtime.kind === 'wsl') {
    return 'linux'
  }
  if (repo?.connectionId || (worktree?.path && isWslUncPath(worktree.path))) {
    return 'linux'
  }
  return CLIENT_PLATFORM
}

export function isRemoteResumeLaunch(worktreeId: string): boolean {
  return getResumeLaunchPlatform(worktreeId) !== CLIENT_PLATFORM
}
