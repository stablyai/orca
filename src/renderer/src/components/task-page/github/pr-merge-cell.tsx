import React, { useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { ChevronDown, ExternalLink, GitMerge, LoaderCircle } from 'lucide-react'

import { useAppStore } from '@/store'
import { callRuntimeRpc, getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import { useConfirmationDialog } from '@/components/confirmation-dialog-context'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { getSettingsForRepoRuntimeOwner } from '@/lib/repo-runtime-owner'
import { presentGitHubPRMergeState } from '@/components/github-pr-merge-state'
import {
  GITHUB_PR_MERGE_METHOD_LABELS,
  resolveGitHubPRMergeMethods
} from '../../../../../shared/github/pull-request-merge-methods'
import {
  getTaskSourceRuntimeSettings,
  type TaskSourceContext
} from '../../../../../shared/task-source-context'
import type { GitHubPRMergeMethod } from '../../../../../shared/github/pull-request-types'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import type { Repo } from '../../../../../shared/repo-types'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { resolveTaskPullRequestRepo } from './github-reviewer-suggestions'
import type { TaskPageGitHubWorkItemMutationRunner } from './github-work-item-mutation-runner'

export function PRMergeCell({
  item,
  repo,
  sourceContext,
  workItemMutation
}: {
  item: GitHubWorkItem
  repo: Repo | null
  sourceContext?: TaskSourceContext | null
  workItemMutation: TaskPageGitHubWorkItemMutationRunner
}): React.JSX.Element {
  const [merging, setMerging] = useState(false)
  const confirm = useConfirmationDialog()
  const repoOwnerSettings = useAppStore(
    useShallow((s) => getSettingsForRepoRuntimeOwner(s, repo?.id ?? null))
  )
  const sourceSettings = useMemo(
    () =>
      sourceContext?.provider === 'github'
        ? ({
            ...repoOwnerSettings,
            ...getTaskSourceRuntimeSettings(sourceContext)
          } as typeof repoOwnerSettings)
        : repoOwnerSettings,
    [repoOwnerSettings, sourceContext]
  )
  if (item.type !== 'pr') {
    return (
      <span className="text-[11px] text-muted-foreground">
        {translate('auto.components.TaskPage.b1eaa18ace', 'Issue')}
      </span>
    )
  }
  const mergePresentation = presentGitHubPRMergeState(item)
  const mergeMethods = resolveGitHubPRMergeMethods(item.mergeMethodSettings)
  const prRepo = resolveTaskPullRequestRepo(item)
  const mergeMutationPending = workItemMutation.isIntentPending({
    item,
    intent: { type: 'merge' },
    sourceContext
  })
  const autoMergeMutationPending = mergePresentation.autoMergeAction
    ? workItemMutation.isIntentPending({
        item,
        intent: {
          type: 'setAutoMerge',
          enabled: mergePresentation.autoMergeAction.kind === 'enable'
        },
        sourceContext
      })
    : false
  const mergeDisabled =
    !repo || merging || mergeMutationPending || !mergePresentation.directMergeAvailable

  const handleMerge = async (method: GitHubPRMergeMethod): Promise<void> => {
    if (!repo || mergeDisabled) {
      return
    }
    const label = GITHUB_PR_MERGE_METHOD_LABELS[method]
    const confirmed = await confirm({
      title: translate('auto.components.TaskPage.844dc193c7', '{{value0}} PR #{{value1}}?', {
        value0: label,
        value1: item.number
      }),
      description: translate(
        'auto.components.TaskPage.0506a78337',
        'This will update the pull request on GitHub.'
      ),
      confirmLabel: label
    })
    if (!confirmed) {
      return
    }
    setMerging(true)
    try {
      await workItemMutation.run({
        item,
        intent: { type: 'merge' },
        sourceContext,
        successToast: translate('auto.components.TaskPage.a161925adc', 'Pull request merged'),
        errorToast: translate(
          'auto.components.TaskPage.88f478cdef',
          'Failed to merge pull request'
        ),
        mutate: async () => {
          const target = getActiveRuntimeTarget(sourceSettings)
          const runtimeRepoId =
            sourceContext?.provider === 'github' ? (sourceContext.repoId ?? repo.id) : repo.id
          return target.kind === 'environment'
            ? callRuntimeRpc<{ ok: boolean; error?: string }>(
                target,
                'github.mergePR',
                {
                  repo: runtimeRepoId,
                  prNumber: item.number,
                  method,
                  prRepo
                },
                { timeoutMs: 30_000 }
              )
            : window.api.gh.mergePR({
                repoPath: repo.path,
                repoId: repo.id,
                sourceContext,
                prNumber: item.number,
                method,
                prRepo
              })
        }
      })
    } finally {
      setMerging(false)
    }
  }

  const handleAutoMerge = async (): Promise<void> => {
    if (!repo || autoMergeMutationPending || !mergePresentation.autoMergeAction) {
      return
    }
    const enabled = mergePresentation.autoMergeAction.kind === 'enable'
    setMerging(true)
    try {
      await workItemMutation.run({
        item,
        intent: { type: 'setAutoMerge', enabled },
        sourceContext,
        successToast: enabled
          ? translate('auto.components.TaskPage.fed317634c', 'Auto-merge enabled')
          : translate('auto.components.TaskPage.a5bf86defe', 'Auto-merge disabled'),
        errorToast: enabled
          ? translate('auto.components.TaskPage.a3318684bc', 'Failed to enable auto-merge')
          : translate('auto.components.TaskPage.1a9ea003dc', 'Failed to disable auto-merge'),
        mutate: async () => {
          const target = getActiveRuntimeTarget(sourceSettings)
          const runtimeRepoId =
            sourceContext?.provider === 'github' ? (sourceContext.repoId ?? repo.id) : repo.id
          return target.kind === 'environment'
            ? callRuntimeRpc<{ ok: boolean; error?: string }>(
                target,
                'github.setPRAutoMerge',
                {
                  repo: runtimeRepoId,
                  prNumber: item.number,
                  enabled,
                  method: enabled ? mergeMethods.defaultMethod : undefined,
                  prRepo
                },
                { timeoutMs: 30_000 }
              )
            : window.api.gh.setPRAutoMerge({
                repoPath: repo.path,
                repoId: repo.id,
                sourceContext,
                prNumber: item.number,
                enabled,
                method: enabled ? mergeMethods.defaultMethod : undefined,
                prRepo
              })
        }
      })
    } finally {
      setMerging(false)
    }
  }

  return (
    <DropdownMenu modal={false}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              onClick={(event) => event.stopPropagation()}
              className={cn(
                'inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium transition hover:brightness-110',
                mergePresentation.tone
              )}
            >
              {merging ? (
                <LoaderCircle className="size-3 animate-spin text-muted-foreground" />
              ) : (
                <GitMerge className="size-3" />
              )}
              <span className="truncate">{mergePresentation.label}</span>
              <ChevronDown className="size-2.5 opacity-60" />
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          {mergePresentation.tooltip}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start" onClick={(event) => event.stopPropagation()}>
        {mergePresentation.autoMergeAction && (
          <DropdownMenuItem
            disabled={!repo || merging || autoMergeMutationPending}
            onSelect={() => void handleAutoMerge()}
          >
            <GitMerge className="size-4" />
            {mergePresentation.autoMergeAction.label}
          </DropdownMenuItem>
        )}
        {mergePresentation.autoMergeAction && <DropdownMenuSeparator />}
        {mergeMethods.methods.map(({ method, label }) => (
          <DropdownMenuItem
            key={method}
            disabled={mergeDisabled}
            onSelect={() => void handleMerge(method)}
          >
            <GitMerge className="size-4" />
            {label}
          </DropdownMenuItem>
        ))}
        <DropdownMenuItem onSelect={() => void window.api.shell.openUrl(item.url)}>
          <ExternalLink className="size-4" />
          {translate('auto.components.TaskPage.37d60046e3', 'Open GitHub merge box')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
