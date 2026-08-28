import React, { useCallback, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { CircleDot, GitPullRequest, GitPullRequestClosed, LoaderCircle } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useConfirmationDialog } from '@/components/confirmation-dialog-context'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import { callRuntimeRpc, getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import {
  getGitHubMutationRoutingSettings,
  getGitHubRuntimeRepoId
} from '@/lib/github-source-runtime-context'
import { presentGitHubPRMergeState } from '@/components/github-pr-merge-state'
import {
  GITHUB_PR_MERGE_METHOD_LABELS,
  resolveGitHubPRMergeMethods
} from '../../../../../shared/github/pull-request-merge-methods'
import type { GitHubPRMergeMethod } from '../../../../../shared/github/pull-request-types'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'
import { translate } from '@/i18n/i18n'
import { assertTaskPageGitHubDialogStateAuthority } from '@/components/task-page-github-dialog-state-authority'
import { resolvePullRequestRepo } from '@/components/github/github-work-item-identity'
import { notifyWorkItemDetailsMutation } from '@/components/github/github-work-item-comment-mutations'
import { runPullRequestStateUpdate } from '@/components/github/github-work-item-edit-mutations'
import type { GitHubItemDialogProjectOrigin } from '../load-item-details/github-item-dialog-types'
import { PRActionsMergeMenu } from './pr-actions-merge-menu'
import { WorkItemStateBadge } from '../load-item-details/work-item-state-badge'

export function PRActionsPanel({
  item,
  repoPath,
  repoId,
  sourceContext,
  projectOrigin,
  localState,
  onStateChange,
  onMutated
}: {
  item: GitHubWorkItem
  repoPath: string | null
  repoId: string | null
  sourceContext?: TaskSourceContext | null
  projectOrigin: GitHubItemDialogProjectOrigin | undefined
  localState: GitHubWorkItem['state']
  onStateChange: (state: GitHubWorkItem['state']) => void
  onMutated: () => void
}): React.JSX.Element {
  const [statePending, setStatePending] = useState(false)
  const [mergePending, setMergePending] = useState(false)
  const patchWorkItem = useAppStore((s) => s.patchWorkItem)
  const patchProjectRowContent = useAppStore((s) => s.patchProjectRowContent)
  const confirm = useConfirmationDialog()
  const actionItem = { ...item, state: localState }
  const mergePresentation = presentGitHubPRMergeState(actionItem)
  const mergeMethods = resolveGitHubPRMergeMethods(actionItem.mergeMethodSettings)
  const sourceSettings = useAppStore(
    useShallow((s) =>
      getGitHubMutationRoutingSettings(s, item.repoId ?? repoId ?? null, sourceContext)
    )
  )
  const mergeTarget = getActiveRuntimeTarget(sourceSettings)
  const prRepo = resolvePullRequestRepo(item, projectOrigin)
  const canMutateWithRepoContext =
    !!repoPath || !!projectOrigin || mergeTarget.kind === 'environment'
  const canMutateState = localState !== 'merged' && canMutateWithRepoContext
  const nextState: 'open' | 'closed' = localState === 'closed' ? 'open' : 'closed'
  const canMergeWithRepoContext = !!repoPath || mergeTarget.kind === 'environment'
  const mergeDisabled =
    !canMergeWithRepoContext || mergePending || !mergePresentation.directMergeAvailable

  const patchProjectRowIfNeeded = useCallback(
    (state: GitHubWorkItem['state']) => {
      if (!projectOrigin) {
        return
      }
      patchProjectRowContent(projectOrigin.cacheKey, projectOrigin.projectItemId, { state })
    },
    [patchProjectRowContent, projectOrigin]
  )

  const applyStatePatch = useCallback(
    (state: GitHubWorkItem['state']) => {
      onStateChange(state)
      patchWorkItem(item.id, { state }, item.repoId, { sourceContext })
      patchProjectRowIfNeeded(state)
    },
    [item.id, item.repoId, onStateChange, patchProjectRowIfNeeded, patchWorkItem, sourceContext]
  )

  const handleStateChange = async (): Promise<void> => {
    if (!canMutateState || statePending) {
      return
    }
    const label =
      nextState === 'closed'
        ? translate('auto.components.GitHubItemDialog.4aecf121e7', 'Close')
        : translate('auto.components.GitHubItemDialog.8812225174', 'Reopen')
    const confirmed = await confirm({
      title: translate(
        'auto.components.GitHubItemDialog.03d7216d62',
        '{{value0}} PR #{{value1}}?',
        { value0: label, value1: item.number }
      ),
      description:
        nextState === 'closed'
          ? translate(
              'auto.components.GitHubItemDialog.de45fedf7b',
              'This will close the pull request on GitHub.'
            )
          : translate(
              'auto.components.GitHubItemDialog.b6f1b7adbd',
              'This will reopen the pull request on GitHub.'
            ),
      confirmLabel: label,
      confirmVariant: nextState === 'closed' ? 'destructive' : 'default'
    })
    if (!confirmed) {
      return
    }
    const previousState = localState
    setStatePending(true)
    // Why: without registry authority a search-lagged Tasks refetch silently
    // reverts this row to its pre-mutation state (STA-3343).
    const authority = assertTaskPageGitHubDialogStateAuthority({
      repoId: item.repoId,
      itemId: item.id,
      state: nextState,
      sourceContext
    })
    applyStatePatch(nextState)
    try {
      await runPullRequestStateUpdate({
        repoPath,
        repoId,
        sourceContext,
        projectOrigin,
        number: item.number,
        prRepo,
        updates: { state: nextState }
      })
      useAppStore.getState().recordFeatureInteraction('github-tasks')
      toast.success(
        nextState === 'closed'
          ? translate('auto.components.GitHubItemDialog.9f88657c4e', 'Pull request closed')
          : translate('auto.components.GitHubItemDialog.bd3b4492a0', 'Pull request reopened')
      )
      onMutated()
    } catch (err) {
      if (authority.revert()) {
        applyStatePatch(previousState)
      }
      // Why: full sentences per branch — interpolating a lowercased label breaks locales with different casing rules.
      toast.error(
        err instanceof Error
          ? err.message
          : nextState === 'closed'
            ? translate(
                'auto.components.GitHubItemDialog.09d67a0f9b',
                'Failed to close pull request'
              )
            : translate(
                'auto.components.GitHubItemDialog.88809e79db',
                'Failed to reopen pull request'
              )
      )
    } finally {
      setStatePending(false)
    }
  }

  const handleMerge = async (method: GitHubPRMergeMethod): Promise<void> => {
    if (mergeDisabled) {
      return
    }
    const label = GITHUB_PR_MERGE_METHOD_LABELS[method]
    const confirmed = await confirm({
      title: translate(
        'auto.components.GitHubItemDialog.03d7216d62',
        '{{value0}} PR #{{value1}}?',
        { value0: label, value1: item.number }
      ),
      description: translate(
        'auto.components.GitHubItemDialog.a27ee5ca1a',
        'This will update the pull request on GitHub.'
      ),
      confirmLabel: label
    })
    if (!confirmed) {
      return
    }
    setMergePending(true)
    try {
      const result =
        mergeTarget.kind === 'environment'
          ? await callRuntimeRpc<Awaited<ReturnType<typeof window.api.gh.mergePR>>>(
              mergeTarget,
              'github.mergePR',
              {
                repo: getGitHubRuntimeRepoId(sourceContext, repoId ?? item.repoId),
                prNumber: item.number,
                method,
                prRepo
              },
              { timeoutMs: 30_000 }
            )
          : await window.api.gh.mergePR({
              repoPath: repoPath ?? '',
              repoId: repoId ?? undefined,
              sourceContext,
              prNumber: item.number,
              method,
              prRepo
            })
      if (!result.ok) {
        toast.error(
          result.error ||
            translate('auto.components.GitHubItemDialog.aba792c8b3', 'Failed to merge pull request')
        )
        return
      }
      // Why: merge is confirmed here; hold 'merged' against search-lagged refetches.
      assertTaskPageGitHubDialogStateAuthority({
        repoId: item.repoId,
        itemId: item.id,
        state: 'merged',
        sourceContext
      })
      applyStatePatch('merged')
      if (mergeTarget.kind === 'environment') {
        notifyWorkItemDetailsMutation(
          {
            repoPath: repoPath ?? '',
            repoId: item.repoId,
            sourceContext,
            type: 'pr',
            number: item.number
          },
          { local: false }
        )
      }
      useAppStore.getState().recordFeatureInteraction('github-tasks')
      toast.success(translate('auto.components.GitHubItemDialog.dbe5e2448e', 'Pull request merged'))
      onMutated()
    } catch {
      toast.error(
        translate('auto.components.GitHubItemDialog.aba792c8b3', 'Failed to merge pull request')
      )
    } finally {
      setMergePending(false)
    }
  }

  const handleAutoMerge = async (): Promise<void> => {
    if (!canMergeWithRepoContext || !mergePresentation.autoMergeAction) {
      return
    }
    const enabled = mergePresentation.autoMergeAction.kind === 'enable'
    setMergePending(true)
    try {
      const result =
        mergeTarget.kind === 'environment'
          ? await callRuntimeRpc<Awaited<ReturnType<typeof window.api.gh.setPRAutoMerge>>>(
              mergeTarget,
              'github.setPRAutoMerge',
              {
                repo: getGitHubRuntimeRepoId(sourceContext, repoId ?? item.repoId),
                prNumber: item.number,
                enabled,
                method: enabled ? mergeMethods.defaultMethod : undefined,
                prRepo
              },
              { timeoutMs: 30_000 }
            )
          : await window.api.gh.setPRAutoMerge({
              repoPath: repoPath ?? '',
              repoId: repoId ?? undefined,
              sourceContext,
              prNumber: item.number,
              enabled,
              method: enabled ? mergeMethods.defaultMethod : undefined,
              prRepo
            })
      if (!result.ok) {
        toast.error(
          result.error ||
            (enabled
              ? translate(
                  'auto.components.GitHubItemDialog.825a8fb8cd',
                  'Failed to enable auto-merge'
                )
              : translate(
                  'auto.components.GitHubItemDialog.ce360fc318',
                  'Failed to disable auto-merge'
                ))
        )
        return
      }
      if (mergeTarget.kind === 'environment') {
        notifyWorkItemDetailsMutation(
          {
            repoPath: repoPath ?? '',
            repoId: item.repoId,
            sourceContext,
            type: 'pr',
            number: item.number
          },
          { local: false }
        )
      }
      useAppStore.getState().recordFeatureInteraction('github-tasks')
      toast.success(
        enabled
          ? translate('auto.components.GitHubItemDialog.a35ea5a0f6', 'Auto-merge enabled')
          : translate('auto.components.GitHubItemDialog.4b390bd50d', 'Auto-merge disabled')
      )
      onMutated()
    } catch {
      toast.error(
        enabled
          ? translate('auto.components.GitHubItemDialog.825a8fb8cd', 'Failed to enable auto-merge')
          : translate('auto.components.GitHubItemDialog.ce360fc318', 'Failed to disable auto-merge')
      )
    } finally {
      setMergePending(false)
    }
  }

  return (
    <aside className="rounded-lg border border-border/50 bg-card/50 p-3 shadow-xs">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <GitPullRequest className="size-3.5 text-muted-foreground" />
          <span className="text-[13px] font-medium text-foreground">
            {translate('auto.components.GitHubItemDialog.a2495e4784', 'Pull request')}
          </span>
        </div>
        <WorkItemStateBadge item={actionItem} />
      </div>

      <div className="grid gap-2">
        <PRActionsMergeMenu
          itemUrl={item.url}
          mergePending={mergePending}
          mergeDisabled={mergeDisabled}
          canMergeWithRepoContext={canMergeWithRepoContext}
          mergePresentation={mergePresentation}
          mergeMethods={mergeMethods}
          onMerge={(method) => void handleMerge(method)}
          onAutoMerge={() => void handleAutoMerge()}
        />

        <Button
          type="button"
          variant={nextState === 'closed' ? 'outline' : 'secondary'}
          size="sm"
          className={cn(
            'w-full justify-center gap-2',
            nextState === 'closed' &&
              'border-border bg-background text-foreground hover:bg-accent hover:text-accent-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50'
          )}
          disabled={!canMutateState || statePending}
          onClick={() => void handleStateChange()}
        >
          {statePending ? (
            <LoaderCircle className="size-3.5 animate-spin" />
          ) : nextState === 'closed' ? (
            <GitPullRequestClosed className="size-3.5 text-destructive" />
          ) : (
            <CircleDot className="size-3.5" />
          )}
          {nextState === 'closed'
            ? translate('auto.components.GitHubItemDialog.21860b58d0', 'Close pull request')
            : translate('auto.components.GitHubItemDialog.ec5c4b3ab2', 'Reopen PR')}
        </Button>
      </div>
    </aside>
  )
}
