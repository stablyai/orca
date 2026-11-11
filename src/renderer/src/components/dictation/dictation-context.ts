import { useAppStore } from '@/store'
import { selectRepoByIdForActiveWorkspace } from '@/store/repos/active-workspace-repository'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree/id'
import type { DictationContext } from '../../../../shared/speech-types'

/** The worktree a dictation starts in, with its repo's terms for an engine running in this app. */
export function captureDictationContext(): DictationContext {
  const state = useAppStore.getState()
  const worktreeId = state.activeWorktreeId
  if (!worktreeId) {
    return {}
  }
  const repo = selectRepoByIdForActiveWorkspace(state, getRepoIdFromWorktreeId(worktreeId))
  return {
    worktreeId,
    ...(repo?.dictationTerms ? { repoTerms: repo.dictationTerms } : {}),
    ...(repo ? { repoName: repo.displayName } : {})
  }
}
