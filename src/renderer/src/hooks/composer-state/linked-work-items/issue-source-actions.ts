import type { ComposerModel } from '../composer-model'

type IssueSourceActionsInput = Pick<
  ComposerModel,
  | 'baseBranch'
  | 'baseBranchNamesWorkspace'
  | 'branchAutoNameRef'
  | 'isProjectGroupTarget'
  | 'lastAutoNameRef'
  | 'lastAutoNoteRef'
  | 'linkedWorkItem'
  | 'name'
  | 'noteRef'
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
  | 'setNote'
  | 'setPushTarget'
  | 'setReuseEligibleBranch'
  | 'setReuseSelectedBranch'
  | 'setStartFromResetHint'
  | 'smartSourceSelectionRef'
>

import { useCallback, useMemo } from 'react'
import type { LinearIssue } from '../../../../../shared/linear/issue-types'
import type { ClickUpTask } from '../../../../../shared/clickup/clickup-types'
import type { JiraIssue } from '../../../../../shared/jira/jira-types'
import '@/components/sidebar/workspace-creation/folder/folder-workspace-source-repos'
import { useAccountBackedWorkItemLink } from './account-backed-work-item-link'
import {
  buildLinearWorkspaceSource as toLinearLinkedWorkItem,
  buildClickUpWorkspaceSource,
  buildJiraWorkspaceSource,
  buildWorkspaceSourceSelection,
  shouldApplyWorkspaceSourceAutoName
} from '../../../../../shared/new-workspace/workspace-source'
import {
  getLinkedItemDisplayName,
  getSmartNameSelection as getFolderSmartNameSelection
} from '@/components/sidebar/workspace-creation/folder/folder-workspace-source-selection'
import { getLinearLinkedWorkItemBranchName } from '@/lib/work-items/linear/linear-linked-work-item'
import {
  getLinearIssueWorkspaceName,
  getLinkedWorkItemSuggestedName,
  getLinkedWorkItemWorkspaceName
} from '../../../../../shared/workspace/naming/workspace-name'
import { getClickUpTaskWorkspaceSeed } from '@/lib/work-items/clickup/clickup-task-workspace-seed'
import { getJiraIssueKeyCasingSeedOptions } from '@/lib/work-items/jira/jira-issue-key-casing'
import '@/lib/workspace/creation/new-workspace'
import type { LinkedWorkItemSummary } from '@/lib/workspace/creation/new-workspace'
import type { SmartWorkspaceNameSelection } from '@/components/new-workspace/name-field/smart-workspace-name-field-model'
import type { TaskSourceContext } from '../../../../../shared/work-items/task-source-context'

export function useIssueSourceActions(input: IssueSourceActionsInput) {
  const {
    baseBranch,
    baseBranchNamesWorkspace,
    branchAutoNameRef,
    isProjectGroupTarget,
    lastAutoNameRef,
    lastAutoNoteRef,
    linkedWorkItem,
    name,
    noteRef,
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
    setNote,
    setPushTarget,
    setReuseEligibleBranch,
    setReuseSelectedBranch,
    setStartFromResetHint,
    smartSourceSelectionRef
  } = input

  const handleSmartLinearIssueSelect = useCallback(
    (issue: LinearIssue): void => {
      smartSourceSelectionRef.current = null
      if (isProjectGroupTarget) {
        const linkedItem = toLinearLinkedWorkItem(issue)
        setLinkedIssue('')
        setLinkedPR(null)
        setLinkedGitLabIssue(null)
        setLinkedGitLabMR(null)
        setLinkedTaskSourceContext(null)
        setLinkedWorkItem(linkedItem)
        const suggestedName =
          getLinkedItemDisplayName(linkedItem) ?? getLinearIssueWorkspaceName(issue)
        if (
          shouldApplyWorkspaceSourceAutoName({
            currentName: name,
            lastAutoName: lastAutoNameRef.current,
            lookupTextIsQuery: !linkedWorkItem
          }) ||
          (!linkedWorkItem && name.trim().toLowerCase() === issue.identifier.toLowerCase())
        ) {
          setName(suggestedName)
          lastAutoNameRef.current = suggestedName
        }
        return
      }
      setLinkedIssue('')
      setLinkedPR(null)
      setLinkedGitLabIssue(null)
      setLinkedGitLabMR(null)
      setLinkedTaskSourceContext(null)
      const linkedLinearIssue = toLinearLinkedWorkItem(issue)
      setLinkedWorkItem(linkedLinearIssue)
      const suggestedName = getLinearIssueWorkspaceName(issue)
      // Treat typed Linear identifiers as lookup text too, rather than user-owned names.
      if (
        shouldApplyWorkspaceSourceAutoName({
          currentName: name,
          lastAutoName: lastAutoNameRef.current,
          lookupTextIsQuery: !linkedWorkItem
        }) ||
        (!linkedWorkItem && name.trim().toLowerCase() === issue.identifier.toLowerCase())
      ) {
        setName(suggestedName)
        lastAutoNameRef.current = suggestedName
      }
      const linearBranchName = getLinearLinkedWorkItemBranchName(linkedLinearIssue)
      setBranchNameOverride(linearBranchName)
      setBranchNameOverridePreservesNameEdits(Boolean(linearBranchName))
      setForkPushWarning(null)
      branchAutoNameRef.current = linearBranchName ?? ''
      // Source selection must not inject user instructions through note prefill; match GitHub behavior.
    },
    [
      isProjectGroupTarget,
      name,
      linkedWorkItem,
      branchAutoNameRef,
      lastAutoNameRef,
      setBranchNameOverride,
      setBranchNameOverridePreservesNameEdits,
      setForkPushWarning,
      setLinkedGitLabIssue,
      setLinkedGitLabMR,
      setLinkedIssue,
      setLinkedPR,
      setLinkedTaskSourceContext,
      setLinkedWorkItem,
      setName,
      smartSourceSelectionRef
    ]
  )

  const linkAccountBackedWorkItem = useAccountBackedWorkItemLink(input)

  const handleSmartJiraIssueSelect = useCallback(
    (issue: JiraIssue, sourceContext: TaskSourceContext): void => {
      const linkedItem: LinkedWorkItemSummary = buildJiraWorkspaceSource(issue)
      linkAccountBackedWorkItem(
        linkedItem,
        sourceContext,
        getLinkedWorkItemWorkspaceName(linkedItem, getJiraIssueKeyCasingSeedOptions())?.seedName ??
          getLinkedWorkItemSuggestedName(linkedItem)
      )
    },
    [linkAccountBackedWorkItem]
  )

  const handleSmartClickUpTaskSelect = useCallback(
    (task: ClickUpTask, sourceContext: TaskSourceContext): void =>
      linkAccountBackedWorkItem(
        buildClickUpWorkspaceSource(task),
        sourceContext,
        getClickUpTaskWorkspaceSeed(task)
      ),
    [linkAccountBackedWorkItem]
  )

  const handleClearSmartNameSelection = useCallback((): void => {
    smartSourceSelectionRef.current = null
    setLinkedIssue('')
    setLinkedPR(null)
    setLinkedGitLabIssue(null)
    setLinkedGitLabMR(null)
    setLinkedWorkItem(null)
    setLinkedTaskSourceContext(null)
    if (baseBranchNamesWorkspace) {
      setBaseBranch(undefined)
    }
    setCompareBaseRef(undefined)
    setPushTarget(undefined)
    setBranchNameOverride(undefined)
    setBranchNameOverridePreservesNameEdits(false)
    setReuseEligibleBranch(null)
    setReuseSelectedBranch(false)
    setForkPushWarning(null)
    branchAutoNameRef.current = ''
    setStartFromResetHint(null)
    if (name === lastAutoNameRef.current) {
      setName('')
      lastAutoNameRef.current = ''
    }
    if (noteRef.current === lastAutoNoteRef.current) {
      setNote('')
      lastAutoNoteRef.current = ''
    }
  }, [
    name,
    baseBranchNamesWorkspace,
    branchAutoNameRef,
    lastAutoNameRef,
    lastAutoNoteRef,
    noteRef,
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
    setNote,
    setPushTarget,
    setReuseEligibleBranch,
    setReuseSelectedBranch,
    setStartFromResetHint,
    smartSourceSelectionRef
  ])

  const smartNameSelection = useMemo<SmartWorkspaceNameSelection | null>(() => {
    if (isProjectGroupTarget) {
      return getFolderSmartNameSelection(linkedWorkItem)
    }
    return buildWorkspaceSourceSelection({
      linkedWorkItem,
      // Why: only a branch picked to NAME the workspace becomes a source pill; a base ref
      // chosen in the composer's own picker must leave a typed name on screen.
      baseBranch: baseBranchNamesWorkspace ? baseBranch : undefined
    }) as SmartWorkspaceNameSelection | null
  }, [baseBranch, baseBranchNamesWorkspace, isProjectGroupTarget, linkedWorkItem])

  return {
    handleSmartLinearIssueSelect,
    handleSmartJiraIssueSelect,
    handleSmartClickUpTaskSelect,
    handleClearSmartNameSelection,
    smartNameSelection
  }
}
