import type { ComposerModel } from './composer-model'

type BranchStartPointActionsInput = Pick<
  ComposerModel,
  | 'applyLinkedGitLabWorkItem'
  | 'applyLinkedWorkItem'
  | 'branchAutoNameRef'
  | 'handleRepoChange'
  | 'initialProjectGroupAppliedRef'
  | 'lastAutoNoteRef'
  | 'noteRef'
  | 'setBaseBranch'
  | 'setBranchNameOverride'
  | 'setBranchNameOverridePreservesNameEdits'
  | 'setCompareBaseRef'
  | 'setForkPushWarning'
  | 'setNote'
  | 'setProjectError'
  | 'setSelectedProjectGroupId'
  | 'setPushTarget'
  | 'setReuseEligibleBranch'
  | 'setReuseSelectedBranch'
  | 'setSparseDirectories'
  | 'setSparseEnabled'
  | 'setSparseSelectedPresetId'
  | 'setStartFromResetHint'
  | 'smartGitHubPrStartPointSelectionRef'
>

import { useCallback } from 'react'
import type { SparsePreset } from '../../../../shared/worktree/create-types'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import type { GitPushTarget } from '../../../../shared/worktree/types'
import { resolveGitHubWorkItemIdentity } from '@/lib/github-work-item-identity'
import type { GitLabWorkItem } from '../../../../shared/gitlab-types'

export function useBranchStartPointActions(input: BranchStartPointActionsInput) {
  const {
    applyLinkedGitLabWorkItem,
    applyLinkedWorkItem,
    branchAutoNameRef,
    handleRepoChange,
    initialProjectGroupAppliedRef,
    lastAutoNoteRef,
    noteRef,
    setBaseBranch,
    setBranchNameOverride,
    setBranchNameOverridePreservesNameEdits,
    setCompareBaseRef,
    setForkPushWarning,
    setNote,
    setProjectError,
    setSelectedProjectGroupId,
    setPushTarget,
    setReuseEligibleBranch,
    setReuseSelectedBranch,
    setSparseDirectories,
    setSparseEnabled,
    setSparseSelectedPresetId,
    setStartFromResetHint,
    smartGitHubPrStartPointSelectionRef
  } = input

  const showProjectRequiredError = useCallback((): void => {
    setProjectError('Choose or add a project before creating a workspace.')
    requestAnimationFrame(() => {
      document
        .querySelector<HTMLElement>(
          '[data-contextual-tour-target="workspace-creation-project"] [data-project-combobox-root="true"][role="combobox"]'
        )
        ?.focus()
    })
  }, [setProjectError])

  const handleSparseSelectPreset = useCallback(
    (preset: SparsePreset | null): void => {
      if (preset) {
        setSparseEnabled(true)
        setSparseDirectories(preset.directories.join('\n'))
        setSparseSelectedPresetId(preset.id)
      } else {
        setSparseEnabled(false)
        setSparseDirectories('')
        setSparseSelectedPresetId(null)
      }
    },
    [setSparseDirectories, setSparseEnabled, setSparseSelectedPresetId]
  )

  const handleBaseBranchChange = useCallback(
    (next: string | undefined): void => {
      smartGitHubPrStartPointSelectionRef.current = null
      setBaseBranch(next)
      setCompareBaseRef(undefined)
      setPushTarget(undefined)
      setBranchNameOverride(undefined)
      // Why (#5181): Start-from means "new branch from this base", so it never reuses — clear reuse state from a prior smart-field branch pick.
      setBranchNameOverridePreservesNameEdits(false)
      setReuseEligibleBranch(null)
      setReuseSelectedBranch(false)
      setForkPushWarning(null)
      branchAutoNameRef.current = ''
      setStartFromResetHint(null)
    },
    [
      branchAutoNameRef,
      setBaseBranch,
      setBranchNameOverride,
      setBranchNameOverridePreservesNameEdits,
      setCompareBaseRef,
      setForkPushWarning,
      setPushTarget,
      setReuseEligibleBranch,
      setReuseSelectedBranch,
      setStartFromResetHint,
      smartGitHubPrStartPointSelectionRef
    ]
  )

  const handleBaseBranchPrSelect = useCallback(
    (
      nextBaseBranch: string,
      item: GitHubWorkItem,
      nextPushTarget?: GitPushTarget,
      nextBranchNameOverride?: string,
      nextCompareBaseRef?: string
    ): void => {
      setBaseBranch(nextBaseBranch)
      setCompareBaseRef(nextCompareBaseRef)
      setPushTarget(nextPushTarget)
      setBranchNameOverride(nextBranchNameOverride)
      setBranchNameOverridePreservesNameEdits(Boolean(nextBranchNameOverride))
      branchAutoNameRef.current = ''
      setStartFromResetHint(null)
      // Why: a Start-from PR pick is also a linkedWorkItem assignment; reuse applyLinkedWorkItem so auto-name and linkedPR stay one code path.
      applyLinkedWorkItem(item, { preserveBranchNameOverride: Boolean(nextBranchNameOverride) })
      // Why: prefill the note from the PR (only when empty or still an auto-fill) so the sidebar surfaces it without clobbering user text.
      const identity = resolveGitHubWorkItemIdentity(item)
      if (identity.type === 'pr') {
        const suggestedNote = `PR #${identity.number} — ${item.title}`
        const currentNote = noteRef.current
        if (!currentNote.trim() || currentNote === lastAutoNoteRef.current) {
          setNote(suggestedNote)
          lastAutoNoteRef.current = suggestedNote
        }
      }
    },
    [
      applyLinkedWorkItem,
      branchAutoNameRef,
      lastAutoNoteRef,
      noteRef,
      setBaseBranch,
      setBranchNameOverride,
      setBranchNameOverridePreservesNameEdits,
      setCompareBaseRef,
      setNote,
      setPushTarget,
      setStartFromResetHint
    ]
  )

  // Why: GitLab parallel of handleBaseBranchPrSelect; note prefill uses GitLab's `!N` MR convention so the sidebar makes the provider obvious.
  const handleBaseBranchMrSelect = useCallback(
    (
      nextBaseBranch: string,
      item: GitLabWorkItem,
      nextPushTarget?: GitPushTarget,
      nextCompareBaseRef?: string
    ): void => {
      setBaseBranch(nextBaseBranch)
      setCompareBaseRef(nextCompareBaseRef)
      setPushTarget(nextPushTarget)
      setBranchNameOverride(undefined)
      branchAutoNameRef.current = ''
      setStartFromResetHint(null)
      applyLinkedGitLabWorkItem(item)
      if (item.type === 'mr') {
        const suggestedNote = `MR !${item.number} — ${item.title}`
        const currentNote = noteRef.current
        if (!currentNote.trim() || currentNote === lastAutoNoteRef.current) {
          setNote(suggestedNote)
          lastAutoNoteRef.current = suggestedNote
        }
      }
    },
    [
      applyLinkedGitLabWorkItem,
      branchAutoNameRef,
      lastAutoNoteRef,
      noteRef,
      setBaseBranch,
      setBranchNameOverride,
      setCompareBaseRef,
      setNote,
      setPushTarget,
      setStartFromResetHint
    ]
  )

  const selectAddedProjectRepo = useCallback(
    (nextRepoId: string): void => {
      initialProjectGroupAppliedRef.current = true
      setSelectedProjectGroupId(null)
      setProjectError(null)
      handleRepoChange(nextRepoId)
    },
    [handleRepoChange, initialProjectGroupAppliedRef, setProjectError, setSelectedProjectGroupId]
  )

  return {
    showProjectRequiredError,
    handleSparseSelectPreset,
    handleBaseBranchChange,
    handleBaseBranchPrSelect,
    handleBaseBranchMrSelect,
    selectAddedProjectRepo
  }
}
