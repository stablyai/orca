import { useCallback } from 'react'
import type { ComposerModel } from './composer-model'
import {
  getLinkedWorkItemSuggestedName,
  getLinkedWorkItemWorkspaceName,
  type LinkedWorkItemSummary
} from '@/lib/new-workspace'
import { shouldApplyWorkspaceSourceAutoName } from '../../../../shared/new-workspace/workspace-source'
import type { TaskSourceContext } from '../../../../shared/task-source-context'

type TrackerSourceSelectionInput = Pick<
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

/**
 * Why: Jira and ClickUp picks share one flow: link the tracker item, keep its source
 * context so later reads route to the right account, and seed the workspace name.
 */
export function useTrackerSourceSelection(input: TrackerSourceSelectionInput) {
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
      seedOptions?: Parameters<typeof getLinkedWorkItemWorkspaceName>[1]
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
      const suggestedName =
        getLinkedWorkItemWorkspaceName(linkedItem, seedOptions)?.seedName ??
        getLinkedWorkItemSuggestedName(linkedItem)
      // Why: the tracker lookup is async, so a name the user typed while it resolved must survive.
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
