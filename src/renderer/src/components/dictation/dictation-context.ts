import { useAppStore } from '@/store'
import { findRepoForHost } from '@/store/repos/repo-host-identity'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree/id'
import type { DictationContext } from '../../../../shared/speech-types'

/** The worktree a dictation starts in, with its repo's terms for an engine running in this app. */
export function captureDictationContext(): DictationContext {
  const state = useAppStore.getState()
  const worktreeId = state.activeWorktreeId
  if (!worktreeId) {
    return {}
  }
  const repo = findRepoForHost(state.repos, getRepoIdFromWorktreeId(worktreeId), {
    hostId: state.activeWorkspaceExecutionHostId,
    settings: state.settings
  })
  return { worktreeId, ...(repo?.dictationTerms ? { repoTerms: repo.dictationTerms } : {}) }
}
