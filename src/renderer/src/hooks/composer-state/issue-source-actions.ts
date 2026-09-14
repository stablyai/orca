import type { ComposerModel } from './composer-model'

type IssueSourceActionsInput = Pick<
  ComposerModel,
  | 'baseBranch'
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
  | 'smartGitHubPrStartPointSelectionRef'
>

import { useCallback, useMemo } from 'react'
import type { LinearIssue } from '../../../../shared/linear/issue-types'
import type { JiraIssue } from '../../../../shared/jira-types'
import {
  toLinearLinkedWorkItem,
  getLinkedItemDisplayName,
  getSmartNameSelection as getFolderSmartNameSelection
} from '@/components/sidebar/folder-workspace-composer-helpers'
import {
  buildLinearIssueLinkedWorkItem,
  getLinearLinkedWorkItemBranchName
} from '@/lib/linear-linked-work-item'
import { getLinearIssueWorkspaceName } from '../../../../shared/workspace-name'
import {
  getLinkedWorkItemSuggestedName,
  getLinkedWorkItemWorkspaceName,
  type LinkedWorkItemSummary
} from '@/lib/new-workspace'
import {
  buildJiraWorkspaceSource,
  buildWorkspaceSourceSelection,
  shouldApplyWorkspaceSourceAutoName
} from '../../../../shared/new-workspace/workspace-source'
import type { SmartWorkspaceNameSelection } from '@/components/new-workspace/SmartWorkspaceNameField'
import type { TaskSourceContext } from '../../../../shared/task-source-context'

export function useIssueSourceActions(input: IssueSourceActionsInput) {
  const {
    baseBranch,
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
    smartGitHubPrStartPointSelectionRef
  } = input

  const handleSmartLinearIssueSelect = useCallback(
    (issue: LinearIssue): void => {
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
            lastAutoName: lastAutoNameRef.current
          }) ||
          name.trim().toLowerCase() === issue.identifier.toLowerCase()
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
      const linkedLinearIssue = buildLinearIssueLinkedWorkItem(issue)
      setLinkedWorkItem(linkedLinearIssue)
      const suggestedName = getLinearIssueWorkspaceName(issue)
      // Why: same lookup-text rule as applyLinkedWorkItem, plus the typed Linear identifier ("STA-123") that matched this issue.
      if (
        shouldApplyWorkspaceSourceAutoName({
          currentName: name,
          lastAutoName: lastAutoNameRef.current
        }) ||
        name.trim().toLowerCase() === issue.identifier.toLowerCase()
      ) {
        setName(suggestedName)
        lastAutoNameRef.current = suggestedName
      }
      const linearBranchName = getLinearLinkedWorkItemBranchName(linkedLinearIssue)
      setBranchNameOverride(linearBranchName)
      setBranchNameOverridePreservesNameEdits(Boolean(linearBranchName))
      setForkPushWarning(null)
      branchAutoNameRef.current = linearBranchName ?? ''
      // Why: don't prefill the note for a Linear pick — that would turn a source selection into user-authored instructions (matches the GitHub flow).
    },
    [
      isProjectGroupTarget,
      name,
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
      setName
    ]
  )

  const handleSmartJiraIssueSelect = useCallback(
    (issue: JiraIssue, sourceContext: TaskSourceContext): void => {
      const linkedItem: LinkedWorkItemSummary = buildJiraWorkspaceSource(issue)
      setLinkedIssue('')
      setLinkedPR(null)
      setLinkedGitLabIssue(null)
      setLinkedGitLabMR(null)
      setBaseBranch(undefined)
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
      // Why: the Jira lookup is async, so a name the user typed while it resolved must survive.
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

  const handleClearSmartNameSelection = useCallback((): void => {
    smartGitHubPrStartPointSelectionRef.current = null
    setLinkedIssue('')
    setLinkedPR(null)
    setLinkedGitLabIssue(null)
    setLinkedGitLabMR(null)
    setLinkedWorkItem(null)
    setLinkedTaskSourceContext(null)
    setBaseBranch(undefined)
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
    smartGitHubPrStartPointSelectionRef
  ])

  const smartNameSelection = useMemo<SmartWorkspaceNameSelection | null>(() => {
    if (isProjectGroupTarget) {
      return getFolderSmartNameSelection(linkedWorkItem)
    }
    return buildWorkspaceSourceSelection({
      linkedWorkItem,
      baseBranch
    }) as SmartWorkspaceNameSelection | null
  }, [baseBranch, isProjectGroupTarget, linkedWorkItem])

  return {
    handleSmartLinearIssueSelect,
    handleSmartJiraIssueSelect,
    handleClearSmartNameSelection,
    smartNameSelection
  }
}
