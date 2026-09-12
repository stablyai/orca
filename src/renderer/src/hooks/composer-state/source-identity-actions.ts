import type { ComposerModel } from './composer-model'

type SourceIdentityActionsInput = Pick<
  ComposerModel,
  | 'applyLinkedWorkItem'
  | 'branchAutoNameRef'
  | 'branchNameOverride'
  | 'branchNameOverridePreservesNameEdits'
  | 'forkPushWarning'
  | 'lastAutoNameRef'
  | 'linkedWorkItem'
  | 'name'
  | 'pushTarget'
  | 'setBranchNameOverride'
  | 'setBranchNameOverridePreservesNameEdits'
  | 'setCreateError'
  | 'setForkPushWarning'
  | 'setLinkDebouncedQuery'
  | 'setLinkDirectItem'
  | 'setLinkPopoverOpen'
  | 'setLinkQuery'
  | 'setLinkedGitLabIssue'
  | 'setLinkedGitLabMR'
  | 'setLinkedIssue'
  | 'setLinkedPR'
  | 'setLinkedTaskSourceContext'
  | 'setLinkedWorkItem'
  | 'setName'
  | 'setPushTarget'
  | 'setReuseEligibleBranch'
  | 'setReuseSelectedBranch'
  | 'smartGitHubPrStartPointSelectionRef'
>

import { useCallback } from 'react'
import type { GitLabWorkItem } from '../../../../shared/gitlab-types'
import { getLinkedWorkItemSuggestedName, getLinkedWorkItemWorkspaceName } from '@/lib/new-workspace'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import { shouldApplyWorkspaceSourceAutoName } from '../../../../shared/new-workspace/workspace-source'
import { isLinearLinkedWorkItem } from '@/lib/linear-linked-work-item'
import { resolveComposerManualBranchNameChange } from '../composer-branch-selection'

export function useSourceIdentityActions(input: SourceIdentityActionsInput) {
  const {
    applyLinkedWorkItem,
    branchAutoNameRef,
    branchNameOverride,
    branchNameOverridePreservesNameEdits,
    forkPushWarning,
    lastAutoNameRef,
    linkedWorkItem,
    name,
    pushTarget,
    setBranchNameOverride,
    setBranchNameOverridePreservesNameEdits,
    setCreateError,
    setForkPushWarning,
    setLinkDebouncedQuery,
    setLinkDirectItem,
    setLinkPopoverOpen,
    setLinkQuery,
    setLinkedGitLabIssue,
    setLinkedGitLabMR,
    setLinkedIssue,
    setLinkedPR,
    setLinkedTaskSourceContext,
    setLinkedWorkItem,
    setName,
    setPushTarget,
    setReuseEligibleBranch,
    setReuseSelectedBranch,
    smartGitHubPrStartPointSelectionRef
  } = input

  // Why: review routing prefers one provider identity — clear the opposite provider slots so stale hidden fields can't win later.
  const applyLinkedGitLabWorkItem = useCallback(
    (item: GitLabWorkItem): void => {
      smartGitHubPrStartPointSelectionRef.current = null
      if (item.type === 'issue') {
        setLinkedGitLabIssue(item.number)
        setLinkedGitLabMR(null)
      } else {
        setLinkedGitLabIssue(null)
        setLinkedGitLabMR(item.number)
      }
      setLinkedIssue('')
      setLinkedPR(null)
      setLinkedTaskSourceContext(null)
      setLinkedWorkItem({
        type: item.type,
        provider: 'gitlab',
        number: item.number,
        title: item.title,
        url: item.url
      })
      // Why: GitLabWorkItem.branchName lines up structurally with GitHubWorkItem's; cast to reuse the naming heuristic without forking it.
      const suggestedName = getLinkedWorkItemSuggestedName({
        type: item.type === 'mr' ? 'pr' : 'issue',
        number: item.number,
        title: item.title,
        branchName: item.branchName
      } as unknown as GitHubWorkItem)
      const titleName = getLinkedWorkItemWorkspaceName({
        type: item.type,
        provider: 'gitlab',
        number: item.number,
        title: item.title
      })
      const nextName = titleName?.seedName ?? suggestedName
      if (
        nextName &&
        shouldApplyWorkspaceSourceAutoName({
          currentName: name,
          lastAutoName: lastAutoNameRef.current
        })
      ) {
        setName(nextName)
        lastAutoNameRef.current = nextName
      }
      setBranchNameOverride(undefined)
      setBranchNameOverridePreservesNameEdits(false)
      branchAutoNameRef.current = ''
    },
    [
      name,
      branchAutoNameRef,
      lastAutoNameRef,
      setBranchNameOverride,
      setBranchNameOverridePreservesNameEdits,
      setLinkedGitLabIssue,
      setLinkedGitLabMR,
      setLinkedIssue,
      setLinkedPR,
      setLinkedTaskSourceContext,
      setLinkedWorkItem,
      setName,
      smartGitHubPrStartPointSelectionRef
    ]
  )

  const handleSelectLinkedItem = useCallback(
    (item: GitHubWorkItem): void => {
      smartGitHubPrStartPointSelectionRef.current = null
      applyLinkedWorkItem(item)
      setLinkPopoverOpen(false)
      setLinkQuery('')
      setLinkDebouncedQuery('')
      setLinkDirectItem(null)
    },
    [
      applyLinkedWorkItem,
      setLinkDebouncedQuery,
      setLinkDirectItem,
      setLinkPopoverOpen,
      setLinkQuery,
      smartGitHubPrStartPointSelectionRef
    ]
  )

  const handleLinkPopoverChange = useCallback(
    (open: boolean): void => {
      setLinkPopoverOpen(open)
      if (!open) {
        setLinkQuery('')
        setLinkDebouncedQuery('')
        setLinkDirectItem(null)
      }
    },
    [setLinkDebouncedQuery, setLinkDirectItem, setLinkPopoverOpen, setLinkQuery]
  )

  const handleRemoveLinkedWorkItem = useCallback((): void => {
    smartGitHubPrStartPointSelectionRef.current = null
    const removedLinearItem = isLinearLinkedWorkItem(linkedWorkItem)
    setLinkedWorkItem(null)
    setLinkedTaskSourceContext(null)
    setLinkedIssue('')
    setLinkedPR(null)
    setForkPushWarning(null)
    if (name === lastAutoNameRef.current) {
      lastAutoNameRef.current = ''
    }
    if (removedLinearItem) {
      // Why: a Linear branch override belongs to its issue; unlinking must not leave it driving a later worktree create.
      setBranchNameOverride(undefined)
      setBranchNameOverridePreservesNameEdits(false)
      branchAutoNameRef.current = ''
    }
  }, [
    linkedWorkItem,
    name,
    branchAutoNameRef,
    lastAutoNameRef,
    setBranchNameOverride,
    setBranchNameOverridePreservesNameEdits,
    setForkPushWarning,
    setLinkedIssue,
    setLinkedPR,
    setLinkedTaskSourceContext,
    setLinkedWorkItem,
    smartGitHubPrStartPointSelectionRef
  ])

  const handleNameValueChange = useCallback(
    (nextName: string): void => {
      // Why: linked items keep refreshing the suggested name only while it's auto-managed; a manual edit stops later picks from clobbering it until cleared.
      if (!nextName.trim()) {
        lastAutoNameRef.current = ''
      } else if (name !== lastAutoNameRef.current) {
        lastAutoNameRef.current = ''
      }
      if (
        branchNameOverride &&
        !branchNameOverridePreservesNameEdits &&
        nextName !== branchAutoNameRef.current
      ) {
        setBranchNameOverride(undefined)
        branchAutoNameRef.current = ''
      }
      setName(nextName)
      setCreateError(null)
    },
    [
      branchNameOverride,
      branchNameOverridePreservesNameEdits,
      name,
      branchAutoNameRef,
      lastAutoNameRef,
      setBranchNameOverride,
      setCreateError,
      setName
    ]
  )

  const handleBranchNameOverrideChange = useCallback(
    (value: string | undefined): void => {
      const next = resolveComposerManualBranchNameChange({
        value,
        pushTarget,
        forkPushWarning
      })
      setBranchNameOverride(next.branchNameOverride)
      setBranchNameOverridePreservesNameEdits(Boolean(next.branchNameOverride))
      setPushTarget(next.pushTarget)
      setForkPushWarning(next.forkPushWarning)
      setReuseEligibleBranch(null)
      setReuseSelectedBranch(false)
      branchAutoNameRef.current = ''
    },
    [
      forkPushWarning,
      pushTarget,
      branchAutoNameRef,
      setBranchNameOverride,
      setBranchNameOverridePreservesNameEdits,
      setForkPushWarning,
      setPushTarget,
      setReuseEligibleBranch,
      setReuseSelectedBranch
    ]
  )

  return {
    applyLinkedGitLabWorkItem,
    handleSelectLinkedItem,
    handleLinkPopoverChange,
    handleRemoveLinkedWorkItem,
    handleNameValueChange,
    handleBranchNameOverrideChange
  }
}
