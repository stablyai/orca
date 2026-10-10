import type { ComposerModel } from './composer-model'
import type { GitHubPrStartPoint } from '../../../../shared/worktree/types'
import type { PendingSmartGitHubSubmitResolution } from './source-selection-decisions'
import { getGitHubLinkedWorkItemIdentity } from './source-selection-decisions'
import { resolveGitHubWorkItemIdentity } from '@/lib/github-work-item-identity'
import { getLinkedWorkItemProvider } from '@/lib/new-workspace'
import { resolveGitHubPrStartPointForRepo } from '@/lib/github-pr-start-point'
import { getSettingsForRepoRuntimeOwner } from '@/lib/repo-runtime-owner'
import { getSmartGitHubSubmitResolution } from '@/lib/smart-github-submit'
import { getForkPushWarning } from '../fork-push-warning'

type SelectedPrSubmitResolutionInput = Pick<
  ComposerModel,
  | 'isProjectGroupTarget'
  | 'selectedRepo'
  | 'selectedRepoIsGit'
  | 'settings'
  | 'smartGitHubPrStartPointSelectionRef'
  | 'setBaseBranch'
  | 'setBaseBranchNamesWorkspace'
  | 'setCompareBaseRef'
  | 'setPushTarget'
  | 'setBranchNameOverride'
  | 'setBranchNameOverridePreservesNameEdits'
  | 'setForkPushWarning'
> & { linkedWorkItem: NonNullable<ComposerModel['linkedWorkItem']> }

export function prepareSelectedPrSubmitResolution(input: SelectedPrSubmitResolutionInput) {
  const {
    isProjectGroupTarget,
    linkedWorkItem,
    selectedRepo,
    selectedRepoIsGit,
    settings,
    smartGitHubPrStartPointSelectionRef,
    setBaseBranch,
    setBaseBranchNamesWorkspace,
    setCompareBaseRef,
    setPushTarget,
    setBranchNameOverride,
    setBranchNameOverridePreservesNameEdits,
    setForkPushWarning
  } = input
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
    return {
      selection: startPointSelection,
      resolveStartPoint: () =>
        resolveGitHubPrStartPointForRepo({
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
        }),
      applyStartPoint: (
        selectedPrStartPoint: GitHubPrStartPoint
      ): Exclude<PendingSmartGitHubSubmitResolution, { kind: 'none' }> => {
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
        setBaseBranchNamesWorkspace(true)
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
    }
  }
  return null
}
