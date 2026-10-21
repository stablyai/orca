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
  | 'smartSourceSelectionRef'
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
    smartSourceSelectionRef
  } = input

  // Why: review routing prefers one provider identity — clear the opposite provider slots so stale hidden fields can't win later.
  const applyLinkedGitLabWorkItem = useCallback(
    (item: GitLabWorkItem): void => {
      smartSourceSelectionRef.current = null
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
          lastAutoName: lastAutoNameRef.current,
          lookupTextIsQuery: !linkedWorkItem
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
      linkedWorkItem,
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
      smartSourceSelectionRef
    ]
  )

  const handleSelectLinkedItem = useCallback(
    (item: GitHubWorkItem): void => {
      smartSourceSelectionRef.current = null
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
      smartSourceSelectionRef
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
    smartSourceSelectionRef.current = null
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
    smartSourceSelectionRef
  ])

  const handleNameValueChange = useCallback(
    (nextName: string): void => {
      if (nextName !== name && smartSourceSelectionRef.current?.kind === 'github-submit-lookup') {
        smartSourceSelectionRef.current = null
      }
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
      setName,
      smartSourceSelectionRef
    ]
  )

  const handleBranchNameOverrideChange = useCallback(
    (value: string | undefined): void => {
      if (smartSourceSelectionRef.current?.kind === 'github-submit-lookup') {
        smartSourceSelectionRef.current = null
      }
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
      setReuseSelectedBranch,
      smartSourceSelectionRef
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
