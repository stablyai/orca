import { useCallback } from 'react'
import { toast } from 'sonner'
import type { GiteaWorkItem } from '../../../../shared/gitea-types'
import { toGiteaLinkedWorkItem } from '@/components/sidebar/folder-workspace-composer-helpers'
import { getLinkedWorkItemSuggestedName, getLinkedWorkItemWorkspaceName } from '@/lib/new-workspace'
import { shouldApplyWorkspaceSourceAutoName } from '../../../../shared/new-workspace/workspace-source'
import { runtimeTargetForRepoOwner } from '@/lib/repo-runtime-owner'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { reviewStartPointErrorText } from '@/lib/code-host-error-copy'
import { translate } from '@/i18n/i18n'
import type { GitPushTarget } from '../../../../shared/worktree/types'
import type { ComposerModel } from './composer-model'
import type { GitLabProviderSelectionInput } from './gitlab-provider-selection'

type GiteaProviderSelectionInput = Pick<
  GitLabProviderSelectionInput,
  | 'branchAutoNameRef'
  | 'clearLinkedGiteaItems'
  | 'lastAutoNameRef'
  | 'linkedWorkItem'
  | 'name'
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
  | 'setStartFromResetHint'
  | 'smartSourceSelectionRef'
> &
  Pick<
    ComposerModel,
    | 'eligibleRepos'
    | 'selectedRepo'
    | 'setBaseBranch'
    | 'setLinkedGiteaIssue'
    | 'setLinkedGiteaPR'
    | 'setPushTarget'
  >

export function useGiteaProviderSelection(input: GiteaProviderSelectionInput) {
  const {
    branchAutoNameRef,
    eligibleRepos,
    lastAutoNameRef,
    linkedWorkItem,
    name,
    selectedRepo,
    setBaseBranch,
    setBranchNameOverride,
    setBranchNameOverridePreservesNameEdits,
    setCompareBaseRef,
    setForkPushWarning,
    setLinkedGiteaIssue,
    setLinkedGiteaPR,
    setLinkedGitLabIssue,
    setLinkedGitLabMR,
    setLinkedIssue,
    setLinkedPR,
    setLinkedTaskSourceContext,
    setLinkedWorkItem,
    setName,
    setPushTarget,
    setStartFromResetHint,
    smartSourceSelectionRef
  } = input

  // Why: the other providers' hidden slots must clear so stale identity cannot win review routing.
  const handleSmartGiteaItemSelect = useCallback(
    (item: GiteaWorkItem): void => {
      smartSourceSelectionRef.current = null
      setLinkedGiteaIssue(item.type === 'issue' ? item.number : null)
      setLinkedGiteaPR(item.type === 'pr' ? item.number : null)
      setLinkedGitLabIssue(null)
      setLinkedGitLabMR(null)
      setLinkedIssue('')
      setLinkedPR(null)
      setLinkedTaskSourceContext(null)
      setLinkedWorkItem(toGiteaLinkedWorkItem(item))
      const nextName =
        getLinkedWorkItemWorkspaceName({
          type: item.type,
          provider: 'gitea',
          number: item.number,
          title: item.title
        })?.seedName ?? getLinkedWorkItemSuggestedName({ title: item.title })
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
      setCompareBaseRef(undefined)
      setStartFromResetHint(null)
      setBranchNameOverride(undefined)
      setBranchNameOverridePreservesNameEdits(false)
      setForkPushWarning(null)
      branchAutoNameRef.current = ''
      const runRepo = selectedRepo ?? eligibleRepos.find((repo) => repo.id === item.repoId)
      if (item.type !== 'pr' || !runRepo) {
        return
      }
      const target = runtimeTargetForRepoOwner({ repos: [runRepo] }, runRepo.id)
      if (!target) {
        return
      }
      const startPointSelection = {
        kind: 'gitea-pr',
        repoId: runRepo.id,
        item
      } as const
      smartSourceSelectionRef.current = startPointSelection
      const resolveArgs = {
        wakeWslDistro: true,
        ...(item.branchName ? { headRefName: item.branchName } : {}),
        ...(item.baseRefName ? { baseRefName: item.baseRefName } : {}),
        ...(item.isCrossRepository !== undefined
          ? { isCrossRepository: item.isCrossRepository }
          : {})
      }
      // Picking a PR to create from is a user act: it may start the repo's stopped WSL distro.
      const resolvePrBase =
        target.kind === 'local'
          ? window.api.worktrees.resolveGiteaPrBase({
              repoId: runRepo.id,
              prNumber: item.number,
              ...resolveArgs
            })
          : callRuntimeRpc<
              | {
                  baseBranch: string
                  compareBaseRef?: string
                  pushTarget?: GitPushTarget
                }
              | { error: string }
            >(
              target,
              'worktree.resolveGiteaPrBase',
              { repo: runRepo.id, prNumber: item.number, ...resolveArgs },
              { timeoutMs: 30_000 }
            )
      const clearBase = (): void => {
        setBaseBranch(undefined)
        setCompareBaseRef(undefined)
        setPushTarget(undefined)
      }
      void resolvePrBase
        .then((result) => {
          if (smartSourceSelectionRef.current !== startPointSelection) {
            return
          }
          if ('error' in result) {
            clearBase()
            toast.error(reviewStartPointErrorText(result))
            return
          }
          setBaseBranch(result.baseBranch)
          setCompareBaseRef(result.compareBaseRef)
          setPushTarget(result.pushTarget)
        })
        .catch((error: unknown) => {
          if (smartSourceSelectionRef.current !== startPointSelection) {
            return
          }
          clearBase()
          toast.error(
            error instanceof Error
              ? error.message
              : translate('auto.hooks.useComposerState.b2ead86962', 'Failed to resolve PR base.')
          )
        })
    },
    [
      branchAutoNameRef,
      eligibleRepos,
      lastAutoNameRef,
      linkedWorkItem,
      name,
      selectedRepo,
      setBaseBranch,
      setPushTarget,
      setBranchNameOverride,
      setBranchNameOverridePreservesNameEdits,
      setCompareBaseRef,
      setForkPushWarning,
      setLinkedGiteaIssue,
      setLinkedGiteaPR,
      setLinkedGitLabIssue,
      setLinkedGitLabMR,
      setLinkedIssue,
      setLinkedPR,
      setLinkedTaskSourceContext,
      setLinkedWorkItem,
      setName,
      setStartFromResetHint,
      smartSourceSelectionRef
    ]
  )

  return { handleSmartGiteaItemSelect }
}
