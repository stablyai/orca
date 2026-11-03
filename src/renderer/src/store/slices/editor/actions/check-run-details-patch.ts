import type { EditorGet, EditorSet } from '../types/editor-set-get'
import {
  isSameGitHubRepository,
  isSameGitLabProjectRef,
  type CheckRunDetailsTabPatch
} from '@/components/editor/check-run-details-tab'
import type { OpenCheckRunDetailsState } from '../../../../../../shared/editor-tab-view-types'
import { reconcileCheckDetailsReadingCache } from '@/components/editor/check-details-reading-cache'

/** Patch one known detail tab without stealing focus or overwriting a newer request generation. */
export function createCheckRunDetailsTabPatcher(
  set: EditorSet,
  get: EditorGet,
  requests: WeakSet<OpenCheckRunDetailsState>
) {
  return (
    id: string,
    contextKey: string,
    check: OpenCheckRunDetailsState['check'],
    state: CheckRunDetailsTabPatch
  ): void => {
    let accepted: { previous: OpenCheckRunDetailsState; next: OpenCheckRunDetailsState } | undefined
    set((s) => {
      const existing = s.openFiles.find((f) => f.id === id)
      if (existing?.mode !== 'check-details' || !existing.checkRunDetails) {
        return s
      }
      const current = existing.checkRunDetails
      if (current.contextKey !== contextKey) {
        return s
      }
      if (
        state.requestId !== undefined &&
        current.requestId !== undefined &&
        state.requestId < current.requestId
      ) {
        return s
      }
      // Async sidebar project lookup must not clear a previously known MR ref.
      const githubRepository = state.githubRepository ?? current.githubRepository ?? null
      const gitlabProjectRef = state.gitlabProjectRef ?? current.gitlabProjectRef ?? null
      const nextCheckRunDetails: OpenCheckRunDetailsState = {
        actionsAttempt:
          state.actionsAttempt === undefined ? current.actionsAttempt : state.actionsAttempt,
        actionsContext: state.actionsContext ?? current.actionsContext,
        contextKey,
        check,
        requestId: state.requestId ?? current.requestId,
        details: state.details,
        loading: state.loading,
        error: state.error,
        githubRepository,
        gitlabProjectRef
      }
      if (
        current.actionsAttempt === nextCheckRunDetails.actionsAttempt &&
        current.contextKey === nextCheckRunDetails.contextKey &&
        current.requestId === nextCheckRunDetails.requestId &&
        current.check.status === nextCheckRunDetails.check.status &&
        current.check.conclusion === nextCheckRunDetails.check.conclusion &&
        current.loading === nextCheckRunDetails.loading &&
        current.error === nextCheckRunDetails.error &&
        current.details === nextCheckRunDetails.details &&
        isSameGitHubRepository(current.githubRepository ?? null, githubRepository) &&
        isSameGitLabProjectRef(current.gitlabProjectRef ?? null, gitlabProjectRef)
      ) {
        return s
      }
      accepted = { previous: current, next: nextCheckRunDetails }
      return {
        openFiles: s.openFiles.map((f) =>
          f.id === id ? { ...f, checkRunDetails: nextCheckRunDetails } : f
        )
      }
    })
    if (accepted) {
      const { previous, next } = accepted
      requests.add(next)
      reconcileCheckDetailsReadingCache(id, previous, next, () => {
        const live = get().openFiles.find((file) => file.id === id)
        return live?.mode === 'check-details' && live.checkRunDetails === next
      })
    }
  }
}
