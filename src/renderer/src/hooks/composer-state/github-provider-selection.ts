import type { ComposerModel } from './composer-model'

type GitHubProviderSelectionInput = Pick<
  ComposerModel,
  | 'applyLinkedWorkItem'
  | 'branchAutoNameRef'
  | 'eligibleRepos'
  | 'handleBaseBranchPrSelect'
  | 'isProjectGroupTarget'
  | 'lastAutoNameRef'
  | 'name'
  | 'selectedRepo'
  | 'selectedRepoGitHubSourceContext'
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
  | 'setStartFromResetHint'
  | 'settings'
  | 'smartGitHubPrStartPointSelectionRef'
>

import { useCallback } from 'react'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import { resolveGitHubWorkItemIdentity } from '@/lib/github-work-item-identity'
import {
  toGitHubLinkedWorkItem,
  getLinkedItemDisplayName
} from '@/components/sidebar/folder-workspace-composer-helpers'
import { shouldApplyWorkspaceSourceAutoName } from '../../../../shared/new-workspace/workspace-source'
import { getSettingsForRepoRuntimeOwner } from '@/lib/repo-runtime-owner'
import { resolveGitHubPrStartPointForRepo } from '@/lib/github-pr-start-point'
import { getForkPushWarning } from '../fork-push-warning'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { SmartGitHubPrStartPointSelection } from './source-selection-decisions'

export function useGitHubProviderSelection(input: GitHubProviderSelectionInput) {
  const {
    applyLinkedWorkItem,
    branchAutoNameRef,
    eligibleRepos,
    handleBaseBranchPrSelect,
    isProjectGroupTarget,
    lastAutoNameRef,
    name,
    selectedRepo,
    selectedRepoGitHubSourceContext,
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
    setStartFromResetHint,
    settings,
    smartGitHubPrStartPointSelectionRef
  } = input

  const handleSmartGitHubItemSelect = useCallback(
    (item: GitHubWorkItem): void => {
      const identity = resolveGitHubWorkItemIdentity(item)
      const normalizedItem: GitHubWorkItem = {
        ...item,
        type: identity.type,
        number: identity.number
      }
      if (isProjectGroupTarget) {
        const linkedItem = toGitHubLinkedWorkItem(normalizedItem)
        setLinkedIssue(identity.type === 'issue' ? String(identity.number) : '')
        setLinkedPR(identity.type === 'pr' ? identity.number : null)
        setLinkedGitLabIssue(null)
        setLinkedGitLabMR(null)
        setLinkedWorkItem(linkedItem)
        setLinkedTaskSourceContext(selectedRepoGitHubSourceContext)
        const nextName = getLinkedItemDisplayName(linkedItem)
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
        return
      }
      setStartFromResetHint(null)
      setBranchNameOverride(undefined)
      setBranchNameOverridePreservesNameEdits(false)
      setForkPushWarning(null)
      branchAutoNameRef.current = ''
      smartGitHubPrStartPointSelectionRef.current = null
      // Why: provider items can come from a different source host than the run host — resolve refs against the run repo, keep item metadata for provider identity.
      const runRepo = selectedRepo ?? eligibleRepos.find((repo) => repo.id === item.repoId)
      applyLinkedWorkItem(normalizedItem)
      if (identity.type !== 'pr' || !runRepo) {
        setBaseBranch(undefined)
        setCompareBaseRef(undefined)
        setPushTarget(undefined)
        return
      }
      setBaseBranch(undefined)
      setCompareBaseRef(undefined)
      setPushTarget(undefined)
      const startPointSelection: SmartGitHubPrStartPointSelection = {
        repoId: runRepo.id,
        item: normalizedItem
      }
      smartGitHubPrStartPointSelectionRef.current = startPointSelection
      const itemRepoSettings = getSettingsForRepoRuntimeOwner(
        { repos: [runRepo], settings },
        runRepo.id
      )
      const resolvePrBase = resolveGitHubPrStartPointForRepo({
        repoId: runRepo.id,
        prNumber: identity.number,
        settings: itemRepoSettings,
        ...(normalizedItem.branchName ? { headRefName: normalizedItem.branchName } : {}),
        ...(normalizedItem.baseRefName ? { baseRefName: normalizedItem.baseRefName } : {}),
        ...(normalizedItem.isCrossRepository !== undefined
          ? { isCrossRepository: normalizedItem.isCrossRepository }
          : {})
      })
      void resolvePrBase
        .then((result) => {
          if (smartGitHubPrStartPointSelectionRef.current !== startPointSelection) {
            return
          }
          startPointSelection.resolved = result
          handleBaseBranchPrSelect(
            result.baseBranch,
            normalizedItem,
            result.pushTarget,
            result.branchNameOverride,
            result.compareBaseRef
          )
          // Why: a fork PR push lands on the contributor's fork; without maintainer-edits allowed GitHub rejects it, so warn up front.
          setForkPushWarning(getForkPushWarning(result))
        })
        .catch((error: unknown) => {
          if (smartGitHubPrStartPointSelectionRef.current !== startPointSelection) {
            return
          }
          setBaseBranch(undefined)
          setCompareBaseRef(undefined)
          setPushTarget(undefined)
          toast.error(
            error instanceof Error
              ? error.message
              : translate('auto.hooks.useComposerState.b2ead86962', 'Failed to resolve PR base.')
          )
        })
    },
    [
      applyLinkedWorkItem,
      eligibleRepos,
      handleBaseBranchPrSelect,
      isProjectGroupTarget,
      name,
      selectedRepo,
      selectedRepoGitHubSourceContext,
      settings,
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
      setStartFromResetHint,
      smartGitHubPrStartPointSelectionRef
    ]
  )

  return {
    handleSmartGitHubItemSelect
  }
}
