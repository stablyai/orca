import type { AppState } from '@/store/types'
import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'

export function canUseStructuredNativeChat(state: AppState, worktreeId: string): boolean {
  if (getExecutionHostIdForWorktree(state, worktreeId) !== 'local') {
    return false
  }
  const projectRuntime = getLocalProjectExecutionRuntimeContext(state, worktreeId)
  return !(projectRuntime?.status === 'repair-required' || projectRuntime?.runtime.kind === 'wsl')
}
