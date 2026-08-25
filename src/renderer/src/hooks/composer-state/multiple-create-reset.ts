import type { ComposerModel } from './composer-model'

type MultipleCreateResetInput = Pick<
  ComposerModel,
  | 'lastAutoNameRef'
  | 'nameInputRef'
  | 'setAgentPrompt'
  | 'setAttachmentPaths'
  | 'setBranchNameOverride'
  | 'setBranchNameOverridePreservesNameEdits'
  | 'setCompareBaseRef'
  | 'setCreateError'
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
  | 'setReuseSelectedBranch'
  | 'setStartFromResetHint'
>

import { useCallback } from 'react'

export function useMultipleCreateReset(input: MultipleCreateResetInput) {
  const {
    lastAutoNameRef,
    nameInputRef,
    setAgentPrompt,
    setAttachmentPaths,
    setBranchNameOverride,
    setBranchNameOverridePreservesNameEdits,
    setCompareBaseRef,
    setCreateError,
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
    setReuseSelectedBranch,
    setStartFromResetHint
  } = input
  const resetForNextCreate = useCallback(() => {
    // Why: clear identity fields derived from a PR pick while retaining repo, base, agent, and group context for sequential creates.
    setName('')
    lastAutoNameRef.current = ''
    setAgentPrompt('')
    setNote('')
    setAttachmentPaths([])
    setLinkedWorkItem(null)
    setLinkedTaskSourceContext(null)
    setLinkedIssue('')
    setLinkedPR(null)
    setLinkedGitLabIssue(null)
    setLinkedGitLabMR(null)
    setBranchNameOverride(undefined)
    setBranchNameOverridePreservesNameEdits(false)
    setCompareBaseRef(undefined)
    setPushTarget(undefined)
    setReuseSelectedBranch(false)
    setStartFromResetHint(null)
    setForkPushWarning(null)
    setCreateError(null)
    requestAnimationFrame(() => nameInputRef.current?.focus())
  }, [
    lastAutoNameRef,
    nameInputRef,
    setAgentPrompt,
    setAttachmentPaths,
    setBranchNameOverride,
    setBranchNameOverridePreservesNameEdits,
    setCompareBaseRef,
    setCreateError,
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
    setReuseSelectedBranch,
    setStartFromResetHint
  ])

  return {
    resetForNextCreate
  }
}
