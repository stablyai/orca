import type { GitLabMrStartPoint } from '../../../../../shared/worktree/types'
import type { Repo } from '../../../../../shared/repository/repo-types'
import type { LinkedWorkItemSummary } from '@/lib/workspace/creation/new-workspace'
import { getLinkedWorkItemWorkspaceName } from '../../../../../shared/workspace/naming/workspace-name'
import { getRepoExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { ipcOrRuntimeTargetForHostId } from '@/runtime/rpc/targets/runtime-client-target'
import { requestGitLabMrStartPoint } from '@/lib/source-control/review/gitlab-mr-start-point'
import { reviewStartPointErrorText } from '@/lib/source-control/remote/code-host-error-copy'
import type { ComposerModel } from '../composer-model'
import type {
  PendingSmartGitHubSubmitResolution,
  SmartSourceSelection
} from './source-selection-decisions'

type GitLabSmartSelection = Extract<SmartSourceSelection, { kind: 'gitlab-mr' }>

/**
 * A linked GitLab MR must start from its source branch. Tasks-page creates carry no start point,
 * so resolve it here instead of silently creating from the default branch.
 */
export async function resolveGitLabMrSubmitStartPoint(args: {
  linkedWorkItem: LinkedWorkItemSummary
  selection: SmartSourceSelection | null
  selectedRepo: Repo | null | undefined
  selectedRepoIsGit: boolean
  isProjectGroupTarget: boolean
  baseBranch: string | undefined
}): Promise<{
  resolution: Exclude<PendingSmartGitHubSubmitResolution, { kind: 'none' }>
  startPoint: GitLabMrStartPoint
  selection: GitLabSmartSelection | null
} | null> {
  const { linkedWorkItem, selectedRepo } = args
  if (
    args.isProjectGroupTarget ||
    !selectedRepo ||
    !args.selectedRepoIsGit ||
    linkedWorkItem.provider !== 'gitlab' ||
    linkedWorkItem.type !== 'mr'
  ) {
    return null
  }
  const selection =
    args.selection?.kind === 'gitlab-mr' &&
    args.selection.repoId === selectedRepo.id &&
    args.selection.item.number === linkedWorkItem.number
      ? args.selection
      : null
  // A base the person picked by hand wins; only an unseeded MR link needs resolving.
  if (!selection && args.baseBranch) {
    return null
  }
  const startPoint =
    selection?.resolved ??
    (await requestGitLabMrStartPointOrThrow(selectedRepo, linkedWorkItem.number, selection))
  if (selection) {
    selection.resolved = startPoint
  }
  const titleName = getLinkedWorkItemWorkspaceName(linkedWorkItem)
  return {
    startPoint,
    selection,
    resolution: {
      kind: 'pr-start-point',
      workspaceName: titleName?.seedName ?? linkedWorkItem.title,
      displayName: titleName?.displayName ?? linkedWorkItem.title,
      linkedWorkItem,
      linkedIssueNumber: null,
      linkedPR: null,
      baseBranch: startPoint.baseBranch,
      ...(startPoint.compareBaseRef ? { compareBaseRef: startPoint.compareBaseRef } : {}),
      ...(startPoint.pushTarget ? { pushTarget: startPoint.pushTarget } : {}),
      ...(startPoint.branchNameOverride
        ? { branchNameOverride: startPoint.branchNameOverride }
        : {})
    }
  }
}

async function requestGitLabMrStartPointOrThrow(
  repo: Repo,
  mrIid: number,
  selection: GitLabSmartSelection | null
): Promise<GitLabMrStartPoint> {
  const item = selection?.item
  const result = await requestGitLabMrStartPoint({
    repoId: repo.id,
    mrIid,
    target: ipcOrRuntimeTargetForHostId(getRepoExecutionHostId(repo)),
    wakeWslDistro: true,
    sourceBranch: item?.branchName,
    targetBranch: item?.baseRefName,
    isCrossRepository: item?.isCrossRepository
  })
  if ('error' in result) {
    throw new Error(reviewStartPointErrorText(result))
  }
  return result
}

export function applyGitLabMrStartPoint(
  startPoint: GitLabMrStartPoint,
  setters: Pick<
    ComposerModel,
    | 'branchAutoNameRef'
    | 'setBaseBranch'
    | 'setBaseBranchNamesWorkspace'
    | 'setBranchNameOverride'
    | 'setBranchNameOverridePreservesNameEdits'
    | 'setCompareBaseRef'
    | 'setPushTarget'
    | 'setStartFromResetHint'
  >
): void {
  setters.setBaseBranch(startPoint.baseBranch)
  setters.setBaseBranchNamesWorkspace(true)
  setters.setCompareBaseRef(startPoint.compareBaseRef)
  setters.setPushTarget(startPoint.pushTarget)
  setters.setBranchNameOverride(startPoint.branchNameOverride)
  setters.setBranchNameOverridePreservesNameEdits(Boolean(startPoint.branchNameOverride))
  setters.branchAutoNameRef.current = ''
  setters.setStartFromResetHint(null)
}

type GitLabSubmitInput = Pick<
  ComposerModel,
  | 'baseBranch'
  | 'isProjectGroupTarget'
  | 'linkedWorkItem'
  | 'selectedRepo'
  | 'selectedRepoIsGit'
  | 'smartSourceSelectionRef'
> &
  Parameters<typeof applyGitLabMrStartPoint>[1]

export async function resolveAndApplyGitLabMrSubmit(
  input: GitLabSubmitInput,
  selection: SmartSourceSelection | null
): Promise<Exclude<PendingSmartGitHubSubmitResolution, { kind: 'none' }> | null> {
  if (!input.linkedWorkItem) {
    return null
  }
  const resolved = await resolveGitLabMrSubmitStartPoint({
    linkedWorkItem: input.linkedWorkItem,
    selection,
    selectedRepo: input.selectedRepo,
    selectedRepoIsGit: input.selectedRepoIsGit,
    isProjectGroupTarget: input.isProjectGroupTarget,
    baseBranch: input.baseBranch
  })
  if (!resolved) {
    return null
  }
  // A newer pick replaced this selection while resolving; return the result without clobbering it.
  if (input.smartSourceSelectionRef.current === selection) {
    applyGitLabMrStartPoint(resolved.startPoint, input)
  }
  return resolved.resolution
}
