import type { TaskPageLinearListEffectsModel } from './use-task-page-linear-list-effects'
import { useEffect } from 'react'
import {
  readLinkedLinearIssuesWithLimit,
  filterLinearIssuesForInOrcaWorkspace
} from '@/components/task-page-linear-in-orca-issues'
import type { LinearIssue } from '../../../shared/linear/issue-types'
import { translate } from '@/i18n/i18n'

function isCurrentLinearRequest(
  requestRef: React.RefObject<{ signature: string; nonce: number } | null>,
  signature: string,
  nonce: number
): boolean {
  return requestRef.current?.signature === signature && requestRef.current?.nonce === nonce
}

export function useTaskPageLinearInOrcaEffects(model: TaskPageLinearListEffectsModel) {
  const {
    fetchLinearIssue,
    refreshLinearIssue,
    linearConnected,
    selectedLinearWorkspaceId,
    taskSource,
    linearTaskSourceContext,
    taskResumeApplied,
    linearMode,
    setLinearIssues,
    setLinearIssuesHasMore,
    setLinearLoading,
    setLinearError,
    linearRefreshNonce,
    lastLinearRequestRef,
    inOrcaLinkedLinearRefsSignature,
    inOrcaLinkedLinearRefsRef
  } = model
  // Why: Has Worktree loads Linear tickets linked on local worktrees, not a Linear list/search query.
  useEffect(() => {
    if (!taskResumeApplied) {
      return
    }
    if (taskSource !== 'linear' || linearMode !== 'in-orca' || !linearConnected) {
      return
    }
    let cancelled = false
    const linkedRefs = inOrcaLinkedLinearRefsRef.current
    const requestSignature = `in-orca::${selectedLinearWorkspaceId ?? 'default'}::${inOrcaLinkedLinearRefsSignature}`
    const previousRequest = lastLinearRequestRef.current
    const isNewSignature = previousRequest?.signature !== requestSignature
    const forceRefresh = linearRefreshNonce > 0 && previousRequest?.nonce !== linearRefreshNonce
    lastLinearRequestRef.current = {
      nonce: linearRefreshNonce,
      signature: requestSignature
    }
    setLinearIssuesHasMore(false)
    setLinearError(null)
    if (linkedRefs.length === 0) {
      setLinearIssues([])
      setLinearLoading(false)
      return () => {
        cancelled = true
      }
    }
    if (isNewSignature) {
      setLinearIssues([])
    }
    setLinearLoading(true)
    // Why: fetchLinearIssue serves anything under the 60s TTL and ignores `force`, so an
    // explicit refresh has to go through refreshLinearIssue or the button does nothing.
    void readLinkedLinearIssuesWithLimit(linkedRefs, (ref) => {
      const read = forceRefresh ? refreshLinearIssue : fetchLinearIssue
      return read(ref.identifier, ref.workspaceId ?? selectedLinearWorkspaceId, {
        sourceContext: ref.sourceContext ?? linearTaskSourceContext
      })
    })
      .then((results) => {
        if (
          cancelled ||
          !isCurrentLinearRequest(lastLinearRequestRef, requestSignature, linearRefreshNonce)
        ) {
          return
        }
        const loaded = results.filter((issue): issue is LinearIssue => issue != null)
        // Why: reads resolve to null instead of throwing, so an all-null result with links
        // present is a load failure — not the "nothing linked yet" empty state.
        if (loaded.length === 0) {
          setLinearError(
            translate(
              'auto.components.TaskPage.linearHasWorktreeLoadFailed',
              'Unable to load Linear issues linked to an Orca workspace.'
            )
          )
          setLinearIssues([])
          setLinearLoading(false)
          return
        }
        if (loaded.length !== results.length) {
          setLinearError(
            translate(
              'auto.components.TaskPage.linearHasWorktreePartialLoadFailed',
              'Some Linear issues linked to an Orca workspace could not be loaded. Refresh to try again.'
            )
          )
        }
        setLinearIssues(filterLinearIssuesForInOrcaWorkspace(loaded, selectedLinearWorkspaceId))
        setLinearLoading(false)
      })
      .catch((err) => {
        if (
          cancelled ||
          !isCurrentLinearRequest(lastLinearRequestRef, requestSignature, linearRefreshNonce)
        ) {
          return
        }
        setLinearError(err instanceof Error ? err.message : 'Failed to load Linear issues.')
        setLinearLoading(false)
      })
    return () => {
      cancelled = true
    }
    // Why: linkedRefs are read from a ref keyed by their signature, so unrelated worktree
    // churn (activity stamps, unread flags) can't re-issue one read per linked ticket.
  }, [
    fetchLinearIssue,
    inOrcaLinkedLinearRefsSignature,
    inOrcaLinkedLinearRefsRef,
    lastLinearRequestRef,
    linearConnected,
    linearMode,
    linearRefreshNonce,
    linearTaskSourceContext,
    refreshLinearIssue,
    selectedLinearWorkspaceId,
    setLinearError,
    setLinearIssues,
    setLinearIssuesHasMore,
    setLinearLoading,
    taskResumeApplied,
    taskSource
  ])
  return model
}
export type TaskPageLinearInOrcaEffectsModel = ReturnType<typeof useTaskPageLinearInOrcaEffects>
