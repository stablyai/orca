import React, { useCallback, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  ChevronDown,
  CircleDot,
  ExternalLink,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  LoaderCircle
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useConfirmationDialog } from '@/components/confirmation-dialog-context'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import { getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import { getGitHubMutationRoutingSettings } from '@/lib/github-source-runtime-context'
import { presentGitHubPRMergeState } from '@/components/github-pr-merge-state'
import { resolveGitHubPRMergeMethods } from '../../../../../shared/github/pull-request-merge-methods'
import { resolvePullRequestRepo } from '@/components/github/github-work-item-identity'
import { translate } from '@/i18n/i18n'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'
import type { PullRequestPageProjectOrigin } from '../page-types'
import { WorkItemStateBadge } from '../presentation/state-badge'
import { changePullRequestState, mergePullRequest, setPullRequestAutoMerge } from './merge-actions'

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
  projectOrigin: PullRequestPageProjectOrigin | undefined
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

  return (
    <aside className="rounded-lg border border-border/50 bg-card p-3 shadow-xs">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <GitPullRequest className="size-3.5 text-muted-foreground" />
          <span className="text-[13px] font-medium text-foreground">
            {translate('auto.components.PullRequestPage.1939d0f663', 'Pull request')}
          </span>
        </div>
        <WorkItemStateBadge item={actionItem} />
      </div>

      <div className="grid gap-2">
        <DropdownMenu modal={false}>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  size="sm"
                  className={cn(
                    'w-full justify-center gap-2 bg-green-600 text-white hover:bg-green-700',
                    'disabled:cursor-not-allowed disabled:opacity-50'
                  )}
                >
                  {mergePending ? (
                    <LoaderCircle className="size-3.5 animate-spin" />
                  ) : (
                    <GitMerge className="size-3.5" />
                  )}
                  {mergePresentation.autoMergeAction?.label ??
                    (mergePresentation.directMergeAvailable
                      ? mergeMethods.defaultLabel
                      : mergePresentation.label)}
                  <ChevronDown className="size-3 opacity-60" />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {!canMergeWithRepoContext
                ? translate(
                    'auto.components.PullRequestPage.eca289e593',
                    'Merge requires a registered local repo'
                  )
                : mergePresentation.tooltip}
            </TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="start" className="w-52">
            {mergePresentation.autoMergeAction && (
              <DropdownMenuItem
                disabled={!canMergeWithRepoContext || mergePending}
                onSelect={() =>
                  void setPullRequestAutoMerge({
                    canMergeWithRepoContext,
                    mergePresentation,
                    item,
                    repoPath,
                    repoId,
                    sourceContext,
                    prRepo,
                    mergeTarget,
                    mergeMethods,
                    setMergePending,
                    onMutated
                  })
                }
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
                onSelect={() =>
                  void mergePullRequest({
                    mergeDisabled,
                    method,
                    item,
                    repoPath,
                    repoId,
                    sourceContext,
                    prRepo,
                    mergeTarget,
                    confirm,
                    setMergePending,
                    applyStatePatch,
                    onMutated
                  })
                }
              >
                <GitMerge className="size-4" />
                {label}
              </DropdownMenuItem>
            ))}
            <DropdownMenuItem onSelect={() => window.api.shell.openUrl(item.url)}>
              <ExternalLink className="size-4" />
              {translate('auto.components.PullRequestPage.7df8d5fc60', 'Open GitHub merge box')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

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
          onClick={() =>
            void changePullRequestState({
              canMutateState,
              statePending,
              nextState,
              localState,
              item,
              repoPath,
              repoId,
              sourceContext,
              projectOrigin,
              prRepo,
              confirm,
              setStatePending,
              applyStatePatch,
              onMutated
            })
          }
        >
          {statePending ? (
            <LoaderCircle className="size-3.5 animate-spin" />
          ) : nextState === 'closed' ? (
            <GitPullRequestClosed className="size-3.5 text-destructive" />
          ) : (
            <CircleDot className="size-3.5" />
          )}
          {nextState === 'closed'
            ? translate('auto.components.PullRequestPage.96d013ed28', 'Close pull request')
            : translate('auto.components.PullRequestPage.9d5425918e', 'Reopen PR')}
        </Button>
      </div>
    </aside>
  )
}
