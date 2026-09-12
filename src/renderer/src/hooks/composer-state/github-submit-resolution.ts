import type { ComposerModel } from './composer-model'

type GitHubSubmitResolutionInput = Pick<
  ComposerModel,
  | 'branchAutoNameRef'
  | 'folderSourceRepos'
  | 'isProjectGroupTarget'
  | 'lastAutoNameRef'
  | 'linkedWorkItem'
  | 'name'
  | 'selectedRepo'
  | 'selectedRepoGitHubSourceContext'
  | 'selectedRepoIsGit'
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
import { resolveGitHubWorkItemIdentity } from '@/lib/github-work-item-identity'
import { getLinkedWorkItemProvider } from '@/lib/new-workspace'
import { resolveGitHubPrStartPointForRepo } from '@/lib/github-pr-start-point'
import { getSettingsForRepoRuntimeOwner } from '@/lib/repo-runtime-owner'
import {
  getSmartGitHubSubmitResolution,
  getSmartGitHubSubmitIntent,
  lookupSmartGitHubSubmitItem
} from '@/lib/smart-github-submit'
import { getForkPushWarning } from '../fork-push-warning'
import { isGitRepoKind } from '../../../../shared/repo-kind'
import { buildTaskSourceContextFromRepo } from '../../../../shared/task-source-context'
import {
  lookupGitHubWorkItemForSource,
  lookupGitHubWorkItemByOwnerRepoForSource
} from '@/lib/github-work-item-source-lookup'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import type { PendingSmartGitHubSubmitResolution } from './source-selection-decisions'
import { getGitHubLinkedWorkItemIdentity } from './source-selection-decisions'

export function useGitHubSubmitResolution(input: GitHubSubmitResolutionInput) {
  const {
    branchAutoNameRef,
    folderSourceRepos,
    isProjectGroupTarget,
    lastAutoNameRef,
    linkedWorkItem,
    name,
    selectedRepo,
    selectedRepoGitHubSourceContext,
    selectedRepoIsGit,
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

  const resolvePendingSmartGitHubSubmit =
    useCallback(async (): Promise<PendingSmartGitHubSubmitResolution> => {
      if (linkedWorkItem) {
        const startPointSelection = smartGitHubPrStartPointSelectionRef.current
        const linkedWorkItemIdentity = getGitHubLinkedWorkItemIdentity(linkedWorkItem)
        const startPointIdentity = startPointSelection
          ? resolveGitHubWorkItemIdentity(startPointSelection.item)
          : null
        if (
          !isProjectGroupTarget &&
          linkedWorkItemIdentity?.type === 'pr' &&
          startPointIdentity?.type === 'pr' &&
          getLinkedWorkItemProvider(linkedWorkItem) === 'github' &&
          selectedRepo &&
          selectedRepoIsGit &&
          startPointSelection?.repoId === selectedRepo.id &&
          startPointIdentity.number === linkedWorkItemIdentity.number
        ) {
          const selectedPrStartPoint =
            startPointSelection.resolved ??
            (await resolveGitHubPrStartPointForRepo({
              repoId: selectedRepo.id,
              prNumber: startPointIdentity.number,
              settings: getSettingsForRepoRuntimeOwner(
                { repos: [selectedRepo], settings },
                selectedRepo.id
              ),
              ...(startPointSelection.item.branchName
                ? { headRefName: startPointSelection.item.branchName }
                : {}),
              ...(startPointSelection.item.baseRefName
                ? { baseRefName: startPointSelection.item.baseRefName }
                : {}),
              ...(startPointSelection.item.isCrossRepository !== undefined
                ? { isCrossRepository: startPointSelection.item.isCrossRepository }
                : {})
            }))
          startPointSelection.resolved = selectedPrStartPoint
          const smartGitHubMetadata = getSmartGitHubSubmitResolution(startPointSelection.item)
          const resolution: Exclude<PendingSmartGitHubSubmitResolution, { kind: 'none' }> = {
            ...smartGitHubMetadata,
            kind: 'pr-start-point',
            baseBranch: selectedPrStartPoint.baseBranch,
            ...(selectedPrStartPoint.compareBaseRef
              ? { compareBaseRef: selectedPrStartPoint.compareBaseRef }
              : {}),
            ...(selectedPrStartPoint.pushTarget
              ? { pushTarget: selectedPrStartPoint.pushTarget }
              : {}),
            ...(selectedPrStartPoint.branchNameOverride
              ? { branchNameOverride: selectedPrStartPoint.branchNameOverride }
              : {})
          }
          setBaseBranch(selectedPrStartPoint.baseBranch)
          setCompareBaseRef(selectedPrStartPoint.compareBaseRef)
          setPushTarget(selectedPrStartPoint.pushTarget)
          if (selectedPrStartPoint.branchNameOverride) {
            setBranchNameOverride(selectedPrStartPoint.branchNameOverride)
            setBranchNameOverridePreservesNameEdits(true)
          } else {
            setBranchNameOverride(undefined)
            setBranchNameOverridePreservesNameEdits(false)
          }
          setForkPushWarning(getForkPushWarning(selectedPrStartPoint))
          return resolution
        }
        return { kind: 'none' }
      }

      const intent = getSmartGitHubSubmitIntent(name)
      if (!intent) {
        return { kind: 'none' }
      }

      const item = isProjectGroupTarget
        ? (
            await Promise.all(
              folderSourceRepos.filter(isGitRepoKind).map((repo) =>
                lookupSmartGitHubSubmitItem({
                  repoPath: repo.path,
                  repoId: repo.id,
                  sourceContext: buildTaskSourceContextFromRepo({
                    provider: 'github',
                    projectId: repo.id,
                    repo
                  }),
                  intent,
                  workItem: lookupGitHubWorkItemForSource,
                  workItemByOwnerRepo: lookupGitHubWorkItemByOwnerRepoForSource
                }).catch(() => null)
              )
            )
          )
            .filter((candidate): candidate is GitHubWorkItem => candidate !== null)
            .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0]
        : selectedRepo && selectedRepoIsGit
          ? await lookupSmartGitHubSubmitItem({
              repoPath: selectedRepo.path,
              repoId: selectedRepo.id,
              sourceContext: selectedRepoGitHubSourceContext,
              intent,
              workItem: lookupGitHubWorkItemForSource,
              workItemByOwnerRepo: lookupGitHubWorkItemByOwnerRepoForSource
            })
          : null
      if (!item) {
        throw new Error('Could not resolve the GitHub item before creating the workspace.')
      }

      const itemIdentity = resolveGitHubWorkItemIdentity(item)
      const prStartPoint =
        !isProjectGroupTarget && itemIdentity.type === 'pr' && selectedRepo && selectedRepoIsGit
          ? await resolveGitHubPrStartPointForRepo({
              repoId: selectedRepo.id,
              prNumber: itemIdentity.number,
              settings: getSettingsForRepoRuntimeOwner(
                { repos: [selectedRepo], settings },
                selectedRepo.id
              ),
              ...(item.branchName ? { headRefName: item.branchName } : {}),
              ...(item.baseRefName ? { baseRefName: item.baseRefName } : {}),
              ...(item.isCrossRepository !== undefined
                ? { isCrossRepository: item.isCrossRepository }
                : {})
            })
          : null
      const smartGitHubMetadata = getSmartGitHubSubmitResolution(item)
      const resolution: Exclude<PendingSmartGitHubSubmitResolution, { kind: 'none' }> = prStartPoint
        ? {
            ...smartGitHubMetadata,
            kind: 'pr-start-point',
            baseBranch: prStartPoint.baseBranch,
            ...(prStartPoint.compareBaseRef ? { compareBaseRef: prStartPoint.compareBaseRef } : {}),
            ...(prStartPoint.pushTarget ? { pushTarget: prStartPoint.pushTarget } : {}),
            ...(prStartPoint.branchNameOverride
              ? { branchNameOverride: prStartPoint.branchNameOverride }
              : {})
          }
        : {
            ...smartGitHubMetadata,
            kind: 'metadata-only'
          }
      // Why: Create can fire before the debounced smart field commits; commit the resolved item here so the form shows the title, not the raw URL.
      setLinkedIssue(
        resolution.linkedIssueNumber !== null ? String(resolution.linkedIssueNumber) : ''
      )
      setLinkedPR(resolution.linkedPR)
      setLinkedGitLabIssue(null)
      setLinkedGitLabMR(null)
      setLinkedWorkItem(resolution.linkedWorkItem)
      setLinkedTaskSourceContext(selectedRepoGitHubSourceContext)
      setName(resolution.workspaceName)
      lastAutoNameRef.current = resolution.workspaceName
      if (prStartPoint) {
        setBaseBranch(prStartPoint.baseBranch)
        setCompareBaseRef(prStartPoint.compareBaseRef)
        setPushTarget(prStartPoint.pushTarget)
        if (prStartPoint.branchNameOverride) {
          setBranchNameOverride(prStartPoint.branchNameOverride)
          setBranchNameOverridePreservesNameEdits(true)
        } else {
          setBranchNameOverride(undefined)
          setBranchNameOverridePreservesNameEdits(false)
        }
        setForkPushWarning(getForkPushWarning(prStartPoint))
      } else {
        setBranchNameOverride(undefined)
        setBranchNameOverridePreservesNameEdits(false)
      }
      branchAutoNameRef.current = ''
      setStartFromResetHint(null)
      return resolution
    }, [
      folderSourceRepos,
      isProjectGroupTarget,
      linkedWorkItem,
      name,
      selectedRepo,
      selectedRepoGitHubSourceContext,
      selectedRepoIsGit,
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
    ])

  return {
    resolvePendingSmartGitHubSubmit
  }
}
