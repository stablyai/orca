import { useCallback } from 'react'
import type { ComposerModel } from './composer-model'
import type { TaskSourceContext } from '../../../../shared/task-source-context'
import type { LinkedWorkItemSummary } from '@/lib/new-workspace'
import { getLinkedWorkItemWorkspaceName, getLinkedWorkItemSuggestedName } from '@/lib/new-workspace'
import { shouldApplyWorkspaceSourceAutoName } from '../../../../shared/new-workspace/workspace-source'

type AccountBackedSourceSelectInput = Pick<
  ComposerModel,
  | 'baseBranchNamesWorkspace'
  | 'branchAutoNameRef'
  | 'lastAutoNameRef'
  | 'name'
  | 'setBaseBranch'
  | 'setBranchNameOverride'
  | 'setBranchNameOverridePreservesNameEdits'
  | 'setCompareBaseRef'
  | 'setForkPushWarning'
  | 'setLinkedGitLabIssue'
  | 'setLinkedGitLabMR'
  | 'setLinkedIssue'
  | 'setLinkedPR'
  | 'setLinkedTaskSourceContext'
  | 'setLinkedWorkItem'
  | 'setName'
  | 'setPushTarget'
>

// Why: Jira and Businessmap picks differ only in how the linked item is built — the
// composer reset and auto-name rules are identical for every account-backed source.
export function useAccountBackedSourceSelect({
  baseBranchNamesWorkspace,
  branchAutoNameRef,
  lastAutoNameRef,
  name,
  setBaseBranch,
  setBranchNameOverride,
  setBranchNameOverridePreservesNameEdits,
  setCompareBaseRef,
  setForkPushWarning,
  setLinkedGitLabIssue,
  setLinkedGitLabMR,
  setLinkedIssue,
  setLinkedPR,
  setLinkedTaskSourceContext,
  setLinkedWorkItem,
  setName,
  setPushTarget
}: AccountBackedSourceSelectInput): (
  linkedItem: LinkedWorkItemSummary,
  sourceContext: TaskSourceContext
) => void {
  return useCallback(
    (linkedItem: LinkedWorkItemSummary, sourceContext: TaskSourceContext): void => {
      setLinkedIssue('')
      setLinkedPR(null)
      setLinkedGitLabIssue(null)
      setLinkedGitLabMR(null)
      if (baseBranchNamesWorkspace) {
        setBaseBranch(undefined)
      }
      setCompareBaseRef(undefined)
      setPushTarget(undefined)
      setBranchNameOverride(undefined)
      setBranchNameOverridePreservesNameEdits(false)
      setForkPushWarning(null)
      branchAutoNameRef.current = ''
      setLinkedWorkItem(linkedItem)
      setLinkedTaskSourceContext(sourceContext)
      const suggestedName =
        getLinkedWorkItemWorkspaceName(linkedItem)?.seedName ??
        getLinkedWorkItemSuggestedName(linkedItem)
      // Why: the lookup is async, so a name the user typed while it resolved must survive.
      if (
        suggestedName &&
        shouldApplyWorkspaceSourceAutoName({
          currentName: name,
          lastAutoName: lastAutoNameRef.current
        })
      ) {
        setName(suggestedName)
        lastAutoNameRef.current = suggestedName
      }
    },
    [
      name,
      baseBranchNamesWorkspace,
      branchAutoNameRef,
      lastAutoNameRef,
      setBaseBranch,
      setBranchNameOverride,
      setBranchNameOverridePreservesNameEdits,
      setCompareBaseRef,
      setForkPushWarning,
      setLinkedGitLabIssue,
      setLinkedGitLabMR,
      setLinkedIssue,
      setLinkedPR,
      setLinkedTaskSourceContext,
      setLinkedWorkItem,
      setName,
      setPushTarget
    ]
  )
}
