import type { ComposerModel } from './composer-model'

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
import type { LinearIssue } from '../../../../shared/linear/issue-types'
import type { JiraIssue } from '../../../../shared/jira/jira-types'
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
import { getJiraIssueKeyCasingSeedOptions } from '@/lib/jira-issue-key-casing'
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
import type { SmartWorkspaceNameSelection } from '@/components/new-workspace/smart-workspace-name-field-model'
import type { TaskSourceContext } from '../../../../shared/task-source-context'

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
      const linkedLinearIssue = buildLinearIssueLinkedWorkItem(issue)
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

  const handleSmartJiraIssueSelect = useCallback(
    (issue: JiraIssue, sourceContext: TaskSourceContext): void => {
      smartSourceSelectionRef.current = null
      const linkedItem: LinkedWorkItemSummary = buildJiraWorkspaceSource(issue)
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
        getLinkedWorkItemWorkspaceName(linkedItem, getJiraIssueKeyCasingSeedOptions())?.seedName ??
        getLinkedWorkItemSuggestedName(linkedItem)
      // Why: the Jira lookup is async, so a name the user typed while it resolved must survive.
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
    handleClearSmartNameSelection,
    smartNameSelection
  }
}
