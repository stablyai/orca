import { useCallback } from 'react'
import { shouldApplyWorkspaceSourceAutoName } from '../../../../../shared/new-workspace/workspace-source'
import type { TaskSourceContext } from '../../../../../shared/work-items/task-source-context'
import type { LinkedWorkItemSummary } from '@/lib/workspace/creation/new-workspace'
import type { ComposerModel } from '../composer-model'

type AccountBackedWorkItemLinkInput = Pick<
  ComposerModel,
  | 'baseBranchNamesWorkspace'
  | 'branchAutoNameRef'
  | 'lastAutoNameRef'
  | 'linkedWorkItem'
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
  | 'smartSourceSelectionRef'
>

/** Links a Jira or ClickUp item with the source context that proves which account it came from. */
export function useAccountBackedWorkItemLink(input: AccountBackedWorkItemLinkInput) {
  const {
    baseBranchNamesWorkspace,
    branchAutoNameRef,
    lastAutoNameRef,
    linkedWorkItem,
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
    setPushTarget,
    smartSourceSelectionRef
  } = input
  return useCallback(
    (
      linkedItem: LinkedWorkItemSummary,
      sourceContext: TaskSourceContext,
      suggestedName: string | undefined
    ): void => {
      smartSourceSelectionRef.current = null
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
      // Why: the account lookup is async, so a name the user typed while it resolved must survive.
      if (
        suggestedName &&
        shouldApplyWorkspaceSourceAutoName({
          currentName: name,
          lastAutoName: lastAutoNameRef.current,
          lookupTextIsQuery: !linkedWorkItem
        })
      ) {
        setName(suggestedName)
        lastAutoNameRef.current = suggestedName
      }
    },
    [
      name,
      linkedWorkItem,
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
      setPushTarget,
      smartSourceSelectionRef
    ]
  )
}
