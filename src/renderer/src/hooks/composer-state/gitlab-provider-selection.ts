import type { ComposerModel } from './composer-model'

type GitLabProviderSelectionInput = Pick<
  ComposerModel,
  | 'applyLinkedGitLabWorkItem'
  | 'branchAutoNameRef'
  | 'eligibleRepos'
  | 'handleBaseBranchMrSelect'
  | 'isProjectGroupTarget'
  | 'lastAutoNameRef'
  | 'linkedWorkItem'
  | 'name'
  | 'selectedRepo'
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
  | 'smartSourceSelectionRef'
>

import { useCallback } from 'react'
import type { GitLabWorkItem } from '../../../../shared/gitlab-types'
import {
  toGitLabLinkedWorkItem,
  getLinkedItemDisplayName
} from '@/components/sidebar/folder-workspace-composer-helpers'
import { shouldApplyWorkspaceSourceAutoName } from '../../../../shared/new-workspace/workspace-source'
import { runtimeTargetForRepoOwner } from '@/lib/repo-runtime-owner'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type { GitPushTarget } from '../../../../shared/worktree/types'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { reviewStartPointErrorText } from '@/lib/code-host-error-copy'

export function useGitLabProviderSelection(input: GitLabProviderSelectionInput) {
  const {
    applyLinkedGitLabWorkItem,
    branchAutoNameRef,
    eligibleRepos,
    handleBaseBranchMrSelect,
    isProjectGroupTarget,
    lastAutoNameRef,
    linkedWorkItem,
    name,
    selectedRepo,
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
    smartSourceSelectionRef
  } = input

  // Resolve MR bases through refs/merge-requests/<iid>/head; issues need no base lookup.
  const handleSmartGitLabItemSelect = useCallback(
    (item: GitLabWorkItem): void => {
      smartSourceSelectionRef.current = null
      if (isProjectGroupTarget) {
        const linkedItem = toGitLabLinkedWorkItem(item)
        setLinkedGitLabIssue(item.type === 'issue' ? item.number : null)
        setLinkedGitLabMR(item.type === 'mr' ? item.number : null)
        setLinkedIssue('')
        setLinkedPR(null)
        setLinkedTaskSourceContext(null)
        setLinkedWorkItem(linkedItem)
        const nextName = getLinkedItemDisplayName(linkedItem)
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
        return
      }
      applyLinkedGitLabWorkItem(item)
      setStartFromResetHint(null)
      setBranchNameOverride(undefined)
      setBranchNameOverridePreservesNameEdits(false)
      setForkPushWarning(null)
      branchAutoNameRef.current = ''
      // Why: MR metadata can be sourced from one host/account while the workspace is created on another for the same logical project.
      const runRepo = selectedRepo ?? eligibleRepos.find((repo) => repo.id === item.repoId)
      if (item.type !== 'mr' || !runRepo) {
        setCompareBaseRef(undefined)
        return
      }
      setCompareBaseRef(undefined)
      const target = runtimeTargetForRepoOwner({ repos: [runRepo] }, runRepo.id)
      if (!target) {
        setCompareBaseRef(undefined)
        return
      }
      const startPointSelection = { kind: 'gitlab-mr', repoId: runRepo.id, item } as const
      smartSourceSelectionRef.current = startPointSelection
      // Picking an MR to create from is a user act: it may start the repo's stopped WSL distro.
      const resolveMrBase =
        target.kind === 'local'
          ? window.api.worktrees.resolveMrBase({
              repoId: runRepo.id,
              mrIid: item.number,
              wakeWslDistro: true,
              ...(item.branchName ? { sourceBranch: item.branchName } : {}),
              ...(item.baseRefName ? { targetBranch: item.baseRefName } : {}),
              ...(item.isCrossRepository !== undefined
                ? { isCrossRepository: item.isCrossRepository }
                : {})
            })
          : callRuntimeRpc<
              | { baseBranch: string; compareBaseRef?: string; pushTarget?: GitPushTarget }
              | { error: string }
            >(
              target,
              'worktree.resolveMrBase',
              {
                repo: runRepo.id,
                mrIid: item.number,
                wakeWslDistro: true,
                ...(item.branchName ? { sourceBranch: item.branchName } : {}),
                ...(item.baseRefName ? { targetBranch: item.baseRefName } : {}),
                ...(item.isCrossRepository !== undefined
                  ? { isCrossRepository: item.isCrossRepository }
                  : {})
              },
              { timeoutMs: 30_000 }
            )
      void resolveMrBase
        .then((result) => {
          if (smartSourceSelectionRef.current !== startPointSelection) {
            return
          }
          if ('error' in result) {
            // Surface base lookup failures and clear stale state instead of silently using repo default.
            setBaseBranch(undefined)
            setCompareBaseRef(undefined)
            setPushTarget(undefined)
            toast.error(reviewStartPointErrorText(result))
            return
          }
          handleBaseBranchMrSelect(
            result.baseBranch,
            item,
            result.pushTarget,
            result.compareBaseRef,
            { sourceAlreadyLinked: true }
          )
        })
        .catch((error: unknown) => {
          if (smartSourceSelectionRef.current !== startPointSelection) {
            return
          }
          setBaseBranch(undefined)
          setCompareBaseRef(undefined)
          setPushTarget(undefined)
          toast.error(
            error instanceof Error
              ? error.message
              : translate('auto.hooks.useComposerState.5f3d2c8a1b', 'Failed to resolve MR base.')
          )
        })
    },
    [
      applyLinkedGitLabWorkItem,
      eligibleRepos,
      handleBaseBranchMrSelect,
      isProjectGroupTarget,
      name,
      linkedWorkItem,
      selectedRepo,
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
      smartSourceSelectionRef
    ]
  )

  return {
    handleSmartGitLabItemSelect
  }
}
