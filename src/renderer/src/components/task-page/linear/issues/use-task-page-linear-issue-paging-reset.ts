import { useEffect, useRef } from 'react'
import type { TaskPageGlobalEffectsModel } from '../../use-task-page-global-effects'
import { LINEAR_ITEM_LIMIT } from '../../task-page-source-context'

type PagingResetModel = Pick<
  TaskPageGlobalEffectsModel,
  | 'appliedLinearSearch'
  | 'linearMode'
  | 'selectedLinearCustomView'
  | 'selectedLinearProject'
  | 'selectedLinearWorkspaceId'
  | 'taskSource'
  | 'setLinearIssueLimit'
  | 'setLinearIssuePage'
  | 'setLinearIssueLoadingTargetPage'
>

/** Returns Linear issue paging to the first page when the listed scope changes. */
export function useTaskPageLinearIssuePagingReset(model: PagingResetModel): void {
  const { setLinearIssueLimit, setLinearIssuePage, setLinearIssueLoadingTargetPage } = model
  const scopeKey = JSON.stringify([
    model.appliedLinearSearch,
    model.linearMode,
    model.selectedLinearCustomView?.id,
    model.selectedLinearProject?.id,
    model.selectedLinearWorkspaceId,
    model.taskSource
  ])
  const resetScopeKeyRef = useRef<string | null>(null)
  useEffect(() => {
    // Why: a preloaded Tasks page re-runs effects when shown again; only a changed scope resets paging.
    if (resetScopeKeyRef.current === scopeKey) {
      return
    }
    resetScopeKeyRef.current = scopeKey
    setLinearIssueLimit(LINEAR_ITEM_LIMIT)
    setLinearIssuePage(0)
    setLinearIssueLoadingTargetPage(null)
  }, [scopeKey, setLinearIssueLimit, setLinearIssueLoadingTargetPage, setLinearIssuePage])
}
