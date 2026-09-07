import type { ComposerModel } from './composer-model'

type GitHubSourceApplicationInput = Pick<
  ComposerModel,
  | 'branchAutoNameRef'
  | 'lastAutoNameRef'
  | 'name'
  | 'selectedRepoGitHubSourceContext'
  | 'setBranchNameOverride'
  | 'setBranchNameOverridePreservesNameEdits'
  | 'setLinkedGitLabIssue'
  | 'setLinkedGitLabMR'
  | 'setLinkedIssue'
  | 'setLinkedPR'
  | 'setLinkedTaskSourceContext'
  | 'setLinkedWorkItem'
  | 'setName'
>

import { useCallback } from 'react'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import { resolveGitHubWorkItemIdentity } from '@/lib/github-work-item-identity'
import { getLinkedWorkItemWorkspaceName, getLinkedWorkItemSuggestedName } from '@/lib/new-workspace'
import { shouldApplyWorkspaceSourceAutoName } from '../../../../shared/new-workspace/workspace-source'

export function useGitHubSourceApplication(input: GitHubSourceApplicationInput) {
  const {
    branchAutoNameRef,
    lastAutoNameRef,
    name,
    selectedRepoGitHubSourceContext,
    setBranchNameOverride,
    setBranchNameOverridePreservesNameEdits,
    setLinkedGitLabIssue,
    setLinkedGitLabMR,
    setLinkedIssue,
    setLinkedPR,
    setLinkedTaskSourceContext,
    setLinkedWorkItem,
    setName
  } = input

  const applyLinkedWorkItem = useCallback(
    (item: GitHubWorkItem, options: { preserveBranchNameOverride?: boolean } = {}): void => {
      const identity = resolveGitHubWorkItemIdentity(item)
      const normalizedItem: GitHubWorkItem = {
        ...item,
        type: identity.type,
        number: identity.number
      }
      if (identity.type === 'issue') {
        setLinkedIssue(String(identity.number))
        setLinkedPR(null)
      } else {
        setLinkedIssue('')
        setLinkedPR(identity.number)
      }
      setLinkedGitLabIssue(null)
      setLinkedGitLabMR(null)
      setLinkedWorkItem({
        type: identity.type,
        provider: 'github',
        number: identity.number,
        title: item.title,
        url: item.url
      })
      setLinkedTaskSourceContext(selectedRepoGitHubSourceContext)
      const suggestedName =
        getLinkedWorkItemWorkspaceName(normalizedItem)?.seedName ??
        getLinkedWorkItemSuggestedName(normalizedItem)
      // Why: a pasted URL/#123 is the lookup query, not a chosen name — replace with the title-derived name or it becomes a slugified-URL workspace name.
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
      if (!options.preserveBranchNameOverride) {
        setBranchNameOverride(undefined)
        setBranchNameOverridePreservesNameEdits(false)
        branchAutoNameRef.current = ''
      }
    },
    [
      name,
      selectedRepoGitHubSourceContext,
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
      setName
    ]
  )

  return {
    applyLinkedWorkItem
  }
}
