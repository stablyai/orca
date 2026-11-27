import { useCallback } from 'react'
import { buildItsaplanLinkedWorkItem } from '@/components/task-page/itsaplan/task-page-itsaplan-workspace-launch'
import { getItsaplanIssueWorkspaceSeed } from '@/components/task-page/task-page-source-context'
import { getJiraIssueKeyCasingSeedOptions } from '@/lib/work-items/jira/jira-issue-key-casing'
import type { LinkedWorkItemSummary } from '@/lib/workspace/creation/new-workspace'
import type { ItsaplanIssue } from '../../../../../shared/itsaplan/itsaplan-types'
import type { JiraIssue } from '../../../../../shared/jira/jira-types'
import {
  buildJiraWorkspaceSource,
  shouldApplyWorkspaceSourceAutoName
} from '../../../../../shared/new-workspace/workspace-source'
import type { TaskSourceContext } from '../../../../../shared/work-items/task-source-context'
import {
  getLinkedWorkItemSuggestedName,
  getLinkedWorkItemWorkspaceName
} from '../../../../../shared/workspace/naming/workspace-name'
import type { IssueSourceActionsInput } from './issue-source-actions'

export function useAccountBackedIssueSelect(input: IssueSourceActionsInput) {
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
  // Why: Jira and It's a Plan issues link through an account-bound source context.
  const selectAccountBackedIssue = useCallback(
    (
      linkedItem: LinkedWorkItemSummary,
      sourceContext: TaskSourceContext,
      seedName: string
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
      // Why: the Jira lookup is async, so a name the user typed while it resolved must survive.
      if (
        seedName &&
        shouldApplyWorkspaceSourceAutoName({
          currentName: name,
          lastAutoName: lastAutoNameRef.current,
          lookupTextIsQuery: !linkedWorkItem
        })
      ) {
        setName(seedName)
        lastAutoNameRef.current = seedName
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
  const handleSmartJiraIssueSelect = useCallback(
    (issue: JiraIssue, sourceContext: TaskSourceContext): void => {
      const linkedItem: LinkedWorkItemSummary = buildJiraWorkspaceSource(issue)
      selectAccountBackedIssue(
        linkedItem,
        sourceContext,
        getLinkedWorkItemWorkspaceName(linkedItem, getJiraIssueKeyCasingSeedOptions())?.seedName ??
          getLinkedWorkItemSuggestedName(linkedItem)
      )
    },
    [selectAccountBackedIssue]
  )
  const handleSmartItsaplanIssueSelect = useCallback(
    (issue: ItsaplanIssue, sourceContext: TaskSourceContext): void =>
      selectAccountBackedIssue(
        buildItsaplanLinkedWorkItem(issue),
        sourceContext,
        getItsaplanIssueWorkspaceSeed(issue)
      ),
    [selectAccountBackedIssue]
  )

  return { handleSmartJiraIssueSelect, handleSmartItsaplanIssueSelect }
}
