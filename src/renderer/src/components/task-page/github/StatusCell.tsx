import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import type { GitHubIssueUpdate } from '../../../../../shared/issue-mutation-types'
import type { Repo } from '../../../../../shared/repo-types'
import {
  type TaskSourceContext,
  getTaskSourceRuntimeSettings
} from '../../../../../shared/task-source-context'
import React, { useState, useMemo, useCallback } from 'react'
import {
  createTaskPageGitHubStatusStateDraft,
  resolveTaskPageGitHubStatusStateDraft,
  updateTaskPageGitHubStatusLocalState
} from '@/components/task-page-github-status-state'
import { useAppStore } from '@/store'
import { useShallow } from 'zustand/react/shallow'
import { getSettingsForRepoRuntimeOwner } from '@/lib/repo-runtime-owner'
import { parseGitHubIssueOrPRLink } from '@/lib/github-links'
import {
  getTaskPageGitHubDuplicateCandidates,
  validateTaskPageGitHubDuplicateTarget,
  type TaskPageGitHubCloseAction,
  buildTaskPageGitHubCloseUpdate,
  getTaskPageGitHubDuplicateTargetErrorMessage
} from '@/components/task-page-github-status-actions'
import { translate } from '@/i18n/i18n'
import { getActiveRuntimeTarget, callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { githubProjectHost } from '../../../../../shared/github/project-identity'
import { TaskPageGitHubWorkItemStateBadge } from '@/components/task-page-github-work-item-status-badge'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { CircleDot, ChevronDown, Copy, CheckCircle2, Ban, ChevronRight } from 'lucide-react'
import type { TaskPageGitHubWorkItemMutationRunner } from '../../task-page-linear-jira-list-model'
import { TaskPageGitHubDuplicatePicker } from './DuplicatePicker'
export function GHStatusCell({
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
  const [statusStateDraft, setStatusStateDraft] = useState(() =>
    createTaskPageGitHubStatusStateDraft(item)
  )
  const [open, setOpen] = useState(false)
  const [statusUpdating, setStatusUpdating] = useState(false)
  const [duplicatePickerOpen, setDuplicatePickerOpen] = useState(false)
  const [duplicateSearch, setDuplicateSearch] = useState('')
  const [duplicateError, setDuplicateError] = useState<string | null>(null)
  const duplicateIssueCandidates = useAppStore(
    useShallow((s) => {
      if (!duplicatePickerOpen) {
        return []
      }
      const deduped = new Map<number, GitHubWorkItem>()
      for (const entry of Object.values(s.workItemsCache)) {
        for (const candidate of entry.data ?? []) {
          if (
            candidate.type === 'issue' &&
            candidate.repoId === item.repoId &&
            candidate.number !== item.number &&
            !deduped.has(candidate.number)
          ) {
            deduped.set(candidate.number, candidate)
          }
        }
      }
      return Array.from(deduped.values()).sort((a, b) => b.number - a.number)
    })
  )
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
  const parsedIssueLink = useMemo(() => parseGitHubIssueOrPRLink(item.url), [item.url])
  const filteredDuplicateCandidates = useMemo(
    () =>
      getTaskPageGitHubDuplicateCandidates(duplicateIssueCandidates, item.number, duplicateSearch),
    [duplicateIssueCandidates, duplicateSearch, item.number]
  )
  const directDuplicateTarget = useMemo(() => {
    const trimmed = duplicateSearch.trim()
    const validation = validateTaskPageGitHubDuplicateTarget(trimmed, item.number)
    if (!trimmed || !validation.ok) {
      return null
    }
    if (
      filteredDuplicateCandidates.some((candidate) => candidate.number === validation.duplicateOf)
    ) {
      return null
    }
    return validation.duplicateOf
  }, [duplicateSearch, filteredDuplicateCandidates, item.number])
  const duplicatePickerTitle = parsedIssueLink?.slug
    ? `${parsedIssueLink.slug.owner}/${parsedIssueLink.slug.repo}`
    : (repo?.displayName ?? translate('auto.components.TaskPage.repository', 'Repository'))
  const resolvedStatusStateDraft = resolveTaskPageGitHubStatusStateDraft(statusStateDraft, item)
  if (resolvedStatusStateDraft !== statusStateDraft) {
    // Why: item rows can refresh from the cache while this cell is mounted; reconcile before paint to avoid one stale status frame.
    setStatusStateDraft(resolvedStatusStateDraft)
  }
  const localState = resolvedStatusStateDraft.localState
  const stateMutationPending = workItemMutation.isIntentPending({
    item,
    intent: {
      type: 'setState',
      state: localState === 'open' ? 'closed' : 'open'
    },
    sourceContext
  })
  const updateLocalState = useCallback(
    (nextState: GitHubWorkItem['state']) => {
      setStatusStateDraft((current) =>
        updateTaskPageGitHubStatusLocalState(current, item, nextState)
      )
    },
    [item]
  )
  const handleStateChange = useCallback(
    async (newState: 'open' | 'closed', closeAction?: TaskPageGitHubCloseAction) => {
      if (
        statusUpdating ||
        stateMutationPending ||
        newState === localState ||
        item.type !== 'issue'
      ) {
        return
      }
      const parsedOwnerRepo = parsedIssueLink?.slug
      if (!repo && !parsedOwnerRepo) {
        return
      }
      const updates: GitHubIssueUpdate =
        newState === 'closed' && closeAction
          ? buildTaskPageGitHubCloseUpdate(closeAction)
          : {
              state: newState
            }
      updateLocalState(newState)
      // Why: coordinator owns durable patch + soft-hide + quiet revalidate; keep
      // the status draft so one-frame flash is still covered until proven safe.
      setStatusUpdating(true)
      try {
        await workItemMutation.run({
          item,
          intent: {
            type: 'setState',
            state: newState,
            closeAction
          },
          sourceContext,
          errorToast: translate('auto.components.TaskPage.1c893195ac', 'Failed to update state'),
          mutate: async () => {
            const target = getActiveRuntimeTarget(sourceSettings)
            // Why: issue rows can be sourced by owner/repo URL instead of the local
            // repo context; slug-aware writes preserve close reasons and duplicates.
            if (parsedOwnerRepo) {
              return target.kind === 'environment'
                ? callRuntimeRpc<{
                    ok?: boolean
                    error?:
                      | {
                          message?: string
                        }
                      | string
                  }>(
                    target,
                    'github.project.updateIssueBySlug',
                    {
                      owner: parsedOwnerRepo.owner,
                      repo: parsedOwnerRepo.repo,
                      host: githubProjectHost(parsedOwnerRepo.host),
                      number: item.number,
                      updates
                    },
                    {
                      timeoutMs: 30_000
                    }
                  )
                : window.api.gh.updateIssueBySlug({
                    owner: parsedOwnerRepo.owner,
                    repo: parsedOwnerRepo.repo,
                    host: githubProjectHost(parsedOwnerRepo.host),
                    number: item.number,
                    updates
                  })
            }
            if (!repo) {
              throw new Error('No GitHub repository context available for this issue.')
            }
            const runtimeRepoId =
              sourceContext?.provider === 'github' ? (sourceContext.repoId ?? repo.id) : repo.id
            return target.kind === 'environment'
              ? callRuntimeRpc<{
                  ok?: boolean
                  error?: string
                }>(
                  target,
                  'github.updateIssue',
                  {
                    repo: runtimeRepoId,
                    number: item.number,
                    updates
                  },
                  {
                    timeoutMs: 30_000
                  }
                )
              : window.api.gh.updateIssue({
                  repoPath: repo.path,
                  repoId: repo.id,
                  sourceContext,
                  number: item.number,
                  updates
                })
          }
        })
      } finally {
        setStatusUpdating(false)
      }
      // Why: draft realigns from item.state via resolveTaskPageGitHubStatusStateDraft
      // when patchWorkItem (begin/rollback) updates the cache-backed row.
    },
    [
      item,
      localState,
      parsedIssueLink,
      repo,
      sourceContext,
      sourceSettings,
      stateMutationPending,
      statusUpdating,
      updateLocalState,
      workItemMutation
    ]
  )
  const closeAsDuplicate = useCallback(
    (targetIssueNumber: number | string) => {
      const validation = validateTaskPageGitHubDuplicateTarget(
        String(targetIssueNumber),
        item.number
      )
      if (!validation.ok) {
        setDuplicateError(getTaskPageGitHubDuplicateTargetErrorMessage(validation, translate))
        return
      }
      setDuplicateError(null)
      handleStateChange('closed', {
        stateReason: 'duplicate',
        duplicateOf: validation.duplicateOf
      })
      setOpen(false)
      setDuplicatePickerOpen(false)
    },
    [handleStateChange, item.number]
  )
  const handleDuplicateSearchSubmit = useCallback(() => {
    const validation = validateTaskPageGitHubDuplicateTarget(duplicateSearch, item.number)
    if (!validation.ok) {
      setDuplicateError(getTaskPageGitHubDuplicateTargetErrorMessage(validation, translate))
      return
    }
    closeAsDuplicate(validation.duplicateOf)
  }, [closeAsDuplicate, duplicateSearch, item.number])
  const handlePopoverOpenChange = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen)
    if (!nextOpen) {
      setDuplicatePickerOpen(false)
      setDuplicateSearch('')
      setDuplicateError(null)
    }
  }, [])
  if (item.type !== 'issue' || (!repo && !parsedIssueLink?.slug)) {
    return <TaskPageGitHubWorkItemStateBadge item={item} />
  }
  return (
    <Popover open={open} onOpenChange={handlePopoverOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={statusUpdating || stateMutationPending}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          className={cn(
            'group/status inline-flex cursor-pointer items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium transition hover:brightness-125 hover:ring-1 hover:ring-white/10',
            localState === 'closed'
              ? 'border-primary/40 bg-primary/10 text-primary'
              : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-200'
          )}
        >
          {localState === 'open' ? <CircleDot className="size-2.5" /> : null}
          <span>
            {localState === 'closed'
              ? translate('auto.components.TaskPage.d09bf34db7', 'Closed')
              : translate('auto.components.TaskPage.606a85c774', 'Open')}
          </span>
          <ChevronDown className="size-2.5 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className={cn(duplicatePickerOpen ? 'w-[360px]' : 'w-56', 'p-1')}
        align="start"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        {duplicatePickerOpen ? (
          <TaskPageGitHubDuplicatePicker
            closeAsDuplicate={closeAsDuplicate}
            directDuplicateTarget={directDuplicateTarget}
            duplicateError={duplicateError}
            duplicatePickerTitle={duplicatePickerTitle}
            duplicateSearch={duplicateSearch}
            filteredDuplicateCandidates={filteredDuplicateCandidates}
            handleDuplicateSearchSubmit={handleDuplicateSearchSubmit}
            setDuplicateError={setDuplicateError}
            setDuplicatePickerOpen={setDuplicatePickerOpen}
            setDuplicateSearch={setDuplicateSearch}
          />
        ) : (
          <>
            <button
              type="button"
              onClick={() => {
                handleStateChange('open')
                setOpen(false)
              }}
              className={cn(
                'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-[12px] hover:bg-accent',
                localState === 'open' && 'bg-accent/50'
              )}
            >
              <CircleDot className="size-4 text-muted-foreground" />
              {translate('auto.components.TaskPage.606a85c774', 'Open')}
            </button>
            <button
              type="button"
              onClick={() => {
                handleStateChange('closed', {
                  stateReason: 'completed'
                })
                setOpen(false)
              }}
              className={cn(
                'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[12px] hover:bg-accent',
                localState === 'closed' && 'bg-accent/50'
              )}
            >
              <CheckCircle2 className="size-4 text-muted-foreground" />
              {translate('auto.components.TaskPage.closeAsCompleted', 'Close as completed')}
            </button>
            <button
              type="button"
              onClick={() => {
                handleStateChange('closed', {
                  stateReason: 'not_planned'
                })
                setOpen(false)
              }}
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[12px] hover:bg-accent"
            >
              <Ban className="size-4 text-muted-foreground" />
              {translate('auto.components.TaskPage.closeAsNotPlanned', 'Close as not planned')}
            </button>
            <button
              type="button"
              onClick={() => {
                setDuplicatePickerOpen(true)
                setDuplicateSearch('')
                setDuplicateError(null)
              }}
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[12px] hover:bg-accent"
            >
              <Copy className="size-4 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">
                {translate('auto.components.TaskPage.closeAsDuplicate', 'Close as duplicate')}
              </span>
              <ChevronRight className="size-3.5 text-muted-foreground" />
            </button>
          </>
        )}
      </PopoverContent>
    </Popover>
  )
}
