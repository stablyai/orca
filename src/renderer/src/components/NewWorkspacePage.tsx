/* eslint-disable max-lines -- Why: the new-workspace page keeps the composer,
task source controls, and GitHub task list co-located so the wiring between the
selected repo, the draft composer, and the work-item list stays readable in one
place while this surface is still evolving. */
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ArrowRight,
  CircleDot,
  EllipsisVertical,
  ExternalLink,
  Github,
  GitPullRequest,
  LoaderCircle,
  RefreshCw,
  Search,
  X
} from 'lucide-react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import RepoCombobox from '@/components/repo/RepoCombobox'
import NewWorkspaceComposerCard from '@/components/NewWorkspaceComposerCard'
import GitHubItemDrawer from '@/components/GitHubItemDrawer'
import { cn } from '@/lib/utils'
import { LightRays } from '@/components/ui/light-rays'
import { useComposerState } from '@/hooks/useComposerState'
import { getLinkedWorkItemSuggestedName } from '@/lib/new-workspace'
import type { LinkedWorkItemSummary } from '@/lib/new-workspace'
import type { GitHubWorkItem, TaskViewPresetId } from '../../../shared/types'

type TaskSource = 'github' | 'linear'
type TaskQueryPreset = {
  id: TaskViewPresetId
  label: string
  query: string
}

type SourceOption = {
  id: TaskSource
  label: string
  Icon: (props: { className?: string }) => React.JSX.Element
  disabled?: boolean
}

function LinearIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={className} fill="currentColor">
      <path d="M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z" />
    </svg>
  )
}

const SOURCE_OPTIONS: SourceOption[] = [
  {
    id: 'github',
    label: 'GitHub',
    Icon: ({ className }) => <Github className={className} />
  },
  {
    id: 'linear',
    label: 'Linear',
    Icon: ({ className }) => <LinearIcon className={className} />
  }
]

const TASK_QUERY_PRESETS: TaskQueryPreset[] = [
  { id: 'all', label: 'All', query: 'is:open' },
  { id: 'issues', label: 'Issues', query: 'is:open' },
  { id: 'my-issues', label: 'My Issues', query: 'assignee:@me is:open' },
  {
    id: 'review',
    label: 'Needs My Review',
    query: 'review-requested:@me is:open'
  },
  { id: 'prs', label: 'PRs', query: 'is:open' },
  { id: 'my-prs', label: 'My PRs', query: 'author:@me is:open' }
]

function getTaskPresetQuery(presetId: TaskViewPresetId | null): string {
  if (!presetId) {
    return 'is:open'
  }
  return TASK_QUERY_PRESETS.find((preset) => preset.id === presetId)?.query ?? 'is:open'
}

const TASK_SEARCH_DEBOUNCE_MS = 300

function formatRelativeTime(input: string): string {
  const date = new Date(input)
  if (Number.isNaN(date.getTime())) {
    return 'recently'
  }

  const diffMs = date.getTime() - Date.now()
  const diffMinutes = Math.round(diffMs / 60_000)
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })

  if (Math.abs(diffMinutes) < 60) {
    return formatter.format(diffMinutes, 'minute')
  }

  const diffHours = Math.round(diffMinutes / 60)
  if (Math.abs(diffHours) < 24) {
    return formatter.format(diffHours, 'hour')
  }

  const diffDays = Math.round(diffHours / 24)
  return formatter.format(diffDays, 'day')
}

function getTaskStatusLabel(item: GitHubWorkItem): string {
  if (item.type === 'issue') {
    return 'Open'
  }
  if (item.state === 'draft') {
    return 'Draft'
  }
  return 'Ready'
}

function getTaskStatusTone(item: GitHubWorkItem): string {
  if (item.type === 'issue') {
    return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-200'
  }
  if (item.state === 'draft') {
    return 'border-slate-500/30 bg-slate-500/10 text-slate-600 dark:text-slate-300'
  }
  return 'border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:text-cyan-200'
}

export default function NewWorkspacePage(): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const pageData = useAppStore((s) => s.newWorkspacePageData)
  const closeNewWorkspacePage = useAppStore((s) => s.closeNewWorkspacePage)
  const clearNewWorkspaceDraft = useAppStore((s) => s.clearNewWorkspaceDraft)
  const activeModal = useAppStore((s) => s.activeModal)
  const openModal = useAppStore((s) => s.openModal)
  const updateSettings = useAppStore((s) => s.updateSettings)

  const { cardProps, composerRef, promptTextareaRef, submit, createDisabled } = useComposerState({
    persistDraft: true,
    initialRepoId: pageData.preselectedRepoId,
    initialName: pageData.prefilledName,
    onCreated: () => {
      clearNewWorkspaceDraft()
      closeNewWorkspacePage()
    }
  })

  const { repoId, eligibleRepos, onRepoChange } = cardProps
  const selectedRepo = eligibleRepos.find((repo) => repo.id === repoId)

  const [taskSource, setTaskSource] = useState<TaskSource>('github')
  const [taskSearchInput, setTaskSearchInput] = useState('')
  const [appliedTaskSearch, setAppliedTaskSearch] = useState('')
  const [activeTaskPreset, setActiveTaskPreset] = useState<TaskViewPresetId | null>('all')
  const [tasksLoading, setTasksLoading] = useState(false)
  const [tasksError, setTasksError] = useState<string | null>(null)
  const [taskRefreshNonce, setTaskRefreshNonce] = useState(0)
  const [workItems, setWorkItems] = useState<GitHubWorkItem[]>([])
  // Why: clicking a GitHub row opens this drawer for a read-only preview.
  // The composer modal is only opened by the drawer's "Use" button, which
  // calls the same handleSelectWorkItem as the old direct row-click flow.
  const [drawerWorkItem, setDrawerWorkItem] = useState<GitHubWorkItem | null>(null)

  const defaultTaskViewPreset = settings?.defaultTaskViewPreset ?? 'all'

  const filteredWorkItems = useMemo(() => {
    if (!activeTaskPreset) {
      return workItems
    }

    return workItems.filter((item) => {
      if (activeTaskPreset === 'issues') {
        return item.type === 'issue'
      }
      if (activeTaskPreset === 'review') {
        return item.type === 'pr'
      }
      if (activeTaskPreset === 'my-issues') {
        return item.type === 'issue'
      }
      if (activeTaskPreset === 'prs') {
        return item.type === 'pr'
      }
      if (activeTaskPreset === 'my-prs') {
        return item.type === 'pr'
      }
      return true
    })
  }, [activeTaskPreset, workItems])

  // Autofocus prompt on mount so the user can start typing immediately.
  useEffect(() => {
    promptTextareaRef.current?.focus()
  }, [promptTextareaRef])

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setAppliedTaskSearch(taskSearchInput)
    }, TASK_SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timeout)
  }, [taskSearchInput])

  useEffect(() => {
    if (taskSource !== 'github' || !selectedRepo) {
      return
    }

    let cancelled = false
    setTasksLoading(true)
    setTasksError(null)

    // Why: the buttons below populate the same search bar the user can edit by
    // hand, so the fetch path has to honor both the preset GitHub query and any
    // ad-hoc qualifiers the user types (for example assignee:@me). The fetch is
    // debounced through `appliedTaskSearch` so backspacing all the way to empty
    // refires the query without spamming GitHub on every keystroke.
    void window.api.gh
      .listWorkItems({
        repoPath: selectedRepo.path,
        limit: 36,
        query: appliedTaskSearch.trim() || undefined
      })
      .then((items) => {
        if (!cancelled) {
          setWorkItems(items)
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setTasksError(error instanceof Error ? error.message : 'Failed to load GitHub work.')
          setWorkItems([])
        }
      })
      .finally(() => {
        if (!cancelled) {
          setTasksLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [appliedTaskSearch, selectedRepo, taskRefreshNonce, taskSource])

  useEffect(() => {
    // Why: the composer should reflect the user's saved default once on mount
    // and after clearing a custom query, but only when there's no active custom
    // search to avoid clobbering their typed text.
    if (taskSearchInput.trim() || appliedTaskSearch.trim()) {
      return
    }

    const query = getTaskPresetQuery(defaultTaskViewPreset)
    if (activeTaskPreset !== defaultTaskViewPreset) {
      setActiveTaskPreset(defaultTaskViewPreset)
    }
    if (taskSearchInput !== query) {
      setTaskSearchInput(query)
    }
    if (appliedTaskSearch !== query) {
      setAppliedTaskSearch(query)
    }
  }, [activeTaskPreset, appliedTaskSearch, defaultTaskViewPreset, taskSearchInput])

  const handleApplyTaskSearch = useCallback((): void => {
    const trimmed = taskSearchInput.trim()
    setTaskSearchInput(trimmed)
    setAppliedTaskSearch(trimmed)
    setActiveTaskPreset(null)
    setTaskRefreshNonce((current) => current + 1)
  }, [taskSearchInput])

  const handleTaskSearchChange = useCallback((event: React.ChangeEvent<HTMLInputElement>): void => {
    const next = event.target.value
    setTaskSearchInput(next)
    setActiveTaskPreset(null)
  }, [])

  const handleSetDefaultTaskPreset = useCallback(
    (presetId: TaskViewPresetId): void => {
      // Why: the default task view is a durable preference, so right-clicking a
      // preset updates the persisted settings instead of only changing the
      // current page state.
      void updateSettings({ defaultTaskViewPreset: presetId }).catch(() => {
        toast.error('Failed to save default task view.')
      })
    },
    [updateSettings]
  )

  const handleTaskSearchKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>): void => {
      if (event.key === 'Enter') {
        event.preventDefault()
        handleApplyTaskSearch()
      }
    },
    [handleApplyTaskSearch]
  )

  const handleSelectWorkItem = useCallback(
    (item: GitHubWorkItem): void => {
      // Why: selecting a task from the list opens the same lightweight composer
      // modal used by Cmd+J, so the prompt path is identical whether the user
      // arrives via palette URL, picked issue/PR, or chose one from this list.
      const linkedWorkItem: LinkedWorkItemSummary = {
        type: item.type,
        number: item.number,
        title: item.title,
        url: item.url
      }
      openModal('new-workspace-composer', {
        linkedWorkItem,
        prefilledName: getLinkedWorkItemSuggestedName(item),
        initialRepoId: repoId
      })
    },
    [openModal, repoId]
  )

  const handleDiscardDraft = useCallback((): void => {
    clearNewWorkspaceDraft()
    closeNewWorkspacePage()
  }, [clearNewWorkspaceDraft, closeNewWorkspacePage])

  useEffect(() => {
    // Why: when the global composer modal is on top, let its own scoped key
    // handler own Enter/Esc so we don't double-fire (e.g. modal Esc closes
    // itself *and* this handler tries to discard the underlying page draft).
    if (activeModal === 'new-workspace-composer') {
      return
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Enter' && event.key !== 'Escape') {
        return
      }

      const target = event.target
      if (!(target instanceof HTMLElement)) {
        return
      }

      if (event.key === 'Escape') {
        // Why: Esc should first dismiss the focused control so users can back
        // out of text entry without accidentally closing the whole composer.
        // Once focus is already outside an input, Esc becomes the discard shortcut.
        if (
          target instanceof HTMLInputElement ||
          target instanceof HTMLTextAreaElement ||
          target instanceof HTMLSelectElement ||
          target.isContentEditable
        ) {
          event.preventDefault()
          target.blur()
          return
        }

        event.preventDefault()
        handleDiscardDraft()
        return
      }

      if (!composerRef.current?.contains(target)) {
        return
      }

      if (createDisabled) {
        return
      }

      if (target instanceof HTMLTextAreaElement && event.shiftKey) {
        return
      }

      event.preventDefault()
      void submit()
    }

    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [activeModal, composerRef, createDisabled, handleDiscardDraft, submit])

  return (
    <div className="relative flex h-full min-h-0 flex-1 overflow-hidden bg-background dark:bg-[#1a1a1a] text-foreground">
      <LightRays
        count={6}
        color="rgba(120, 160, 255, 0.15)"
        blur={44}
        speed={16}
        length="60vh"
        className="z-0"
      />

      {selectedRepo?.badgeColor && (
        <div
          className="pointer-events-none absolute inset-0 z-0 opacity-30 transition-opacity duration-700 ease-in-out"
          style={{
            background: `radial-gradient(circle at top right, ${selectedRepo.badgeColor}, transparent 75%)`
          }}
        />
      )}

      <div className="relative z-10 flex min-h-0 flex-1 flex-col">
        {/* Why: the Esc/discard button is left-aligned to avoid colliding with the
            right-docked GitHub drawer and app sidebar, which also live on the right edge. */}
        <div className="flex-none flex items-center justify-start px-5 py-3 md:px-8 md:py-4">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-8 rounded-full z-10"
                onClick={handleDiscardDraft}
                aria-label="Discard draft and go back"
              >
                <X className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              Discard draft · Esc
            </TooltipContent>
          </Tooltip>
        </div>

        <div className="mx-auto flex w-full max-w-[1120px] flex-1 flex-col min-h-0 px-5 pb-5 md:px-8 md:pb-7">
          <div className="flex-none flex flex-col gap-5">
            <section className="mx-auto w-full max-w-[860px] border-b border-border/50 pb-5">
              <NewWorkspaceComposerCard composerRef={composerRef} {...cardProps} />
            </section>

            <section className="flex flex-col gap-4">
              <div className="flex flex-col gap-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    {SOURCE_OPTIONS.map((source) => {
                      const active = taskSource === source.id
                      return (
                        <Tooltip key={source.id}>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              disabled={source.disabled}
                              onClick={() => setTaskSource(source.id)}
                              aria-label={source.label}
                              className={cn(
                                'group flex h-11 w-11 items-center justify-center rounded-xl border transition',
                                active
                                  ? 'border-border/50 bg-background/50 backdrop-blur-md supports-[backdrop-filter]:bg-background/50'
                                  : 'border-border/50 bg-transparent hover:bg-muted/40',
                                source.disabled && 'cursor-not-allowed opacity-55'
                              )}
                            >
                              <source.Icon className="size-4 text-foreground" />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="bottom" sideOffset={6}>
                            {source.label}
                          </TooltipContent>
                        </Tooltip>
                      )
                    })}
                  </div>
                  <div className="w-[240px]">
                    <RepoCombobox
                      repos={eligibleRepos}
                      value={repoId}
                      onValueChange={onRepoChange}
                      placeholder="Select a repository"
                      triggerClassName="h-11 w-full rounded-[10px] border border-border/50 bg-background/50 backdrop-blur-md px-3 text-sm font-medium shadow-sm transition hover:bg-muted/50 focus:ring-2 focus:ring-ring/20 focus:outline-none supports-[backdrop-filter]:bg-background/50"
                    />
                  </div>
                </div>

                {taskSource === 'github' && (
                  <div className="rounded-[16px] border border-border/50 bg-background/40 backdrop-blur-md p-4 shadow-sm supports-[backdrop-filter]:bg-background/40">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="flex flex-wrap gap-2">
                        {TASK_QUERY_PRESETS.map((option) => {
                          const active = activeTaskPreset === option.id
                          return (
                            <button
                              key={option.id}
                              type="button"
                              onClick={() => {
                                const query = option.query
                                setTaskSearchInput(query)
                                setAppliedTaskSearch(query)
                                setActiveTaskPreset(option.id)
                                setTaskRefreshNonce((current) => current + 1)
                              }}
                              onContextMenu={(event) => {
                                event.preventDefault()
                                handleSetDefaultTaskPreset(option.id)
                              }}
                              className={cn(
                                'rounded-xl border px-3 py-2 text-sm transition',
                                active
                                  ? 'border-border/50 bg-foreground/90 text-background backdrop-blur-md'
                                  : 'border-border/50 bg-transparent text-foreground hover:bg-muted/50'
                              )}
                            >
                              {option.label}
                            </button>
                          )
                        })}
                      </div>

                      <div className="flex shrink-0 items-center gap-2">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="outline"
                              size="icon"
                              onClick={() => setTaskRefreshNonce((current) => current + 1)}
                              disabled={tasksLoading}
                              aria-label="Refresh GitHub work"
                              className="border-border/50 bg-transparent hover:bg-muted/50 backdrop-blur-md supports-[backdrop-filter]:bg-transparent"
                            >
                              {tasksLoading ? (
                                <LoaderCircle className="size-4 animate-spin" />
                              ) : (
                                <RefreshCw className="size-4" />
                              )}
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent side="bottom" sideOffset={6}>
                            Refresh GitHub work
                          </TooltipContent>
                        </Tooltip>
                      </div>
                    </div>

                    <div className="mt-4 flex flex-wrap items-center gap-3">
                      <div className="relative min-w-[320px] flex-1">
                        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                        <Input
                          value={taskSearchInput}
                          onChange={handleTaskSearchChange}
                          onKeyDown={handleTaskSearchKeyDown}
                          placeholder="GitHub search, e.g. assignee:@me is:open"
                          className="h-10 border-border/50 bg-background/50 pl-10 pr-10 backdrop-blur-md supports-[backdrop-filter]:bg-background/50"
                        />
                        {taskSearchInput || appliedTaskSearch ? (
                          <button
                            type="button"
                            aria-label="Clear search"
                            onClick={() => {
                              setTaskSearchInput('')
                              setAppliedTaskSearch('')
                              setActiveTaskPreset(null)
                              setTaskRefreshNonce((current) => current + 1)
                            }}
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground transition hover:text-foreground"
                          >
                            <X className="size-4" />
                          </button>
                        ) : null}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </section>
          </div>

          {taskSource === 'github' ? (
            <div className="mt-4 flex flex-1 flex-col min-h-0 rounded-[16px] border border-border/50 bg-background/30 backdrop-blur-md supports-[backdrop-filter]:bg-background/30 overflow-hidden shadow-sm">
              <div className="flex-none hidden grid-cols-[96px_minmax(0,1.8fr)_minmax(140px,1fr)_150px_120px_90px] gap-4 border-b border-border/50 px-4 py-3 text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground lg:grid">
                <span>ID</span>
                <span>Title / Context</span>
                <span>Source Branch</span>
                <span>System Status</span>
                <span>Updated</span>
                <span />
              </div>

              <div
                className="flex-1 overflow-y-auto scrollbar-sleek"
                style={{ scrollbarGutter: 'stable' }}
              >
                {tasksError ? (
                  <div className="border-b border-border px-4 py-4 text-sm text-destructive">
                    {tasksError}
                  </div>
                ) : null}

                {!tasksLoading && filteredWorkItems.length === 0 ? (
                  <div className="px-4 py-10 text-center">
                    <p className="text-base font-medium text-foreground">No matching GitHub work</p>
                    <p className="mt-2 text-sm text-muted-foreground">
                      Change the query or clear it.
                    </p>
                  </div>
                ) : null}

                <div className="divide-y divide-border/50">
                  {filteredWorkItems.map((item) => {
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => setDrawerWorkItem(item)}
                        className="grid w-full gap-4 px-4 py-4 text-left transition hover:bg-muted/40 lg:grid-cols-[96px_minmax(0,1.8fr)_minmax(140px,1fr)_150px_120px_90px]"
                      >
                        <div className="flex items-center">
                          <span className="inline-flex items-center gap-1.5 rounded-lg border border-border/50 bg-muted/40 px-2.5 py-1.5 text-muted-foreground">
                            {item.type === 'pr' ? (
                              <GitPullRequest className="size-3.5" />
                            ) : (
                              <CircleDot className="size-3.5" />
                            )}
                            <span className="font-mono text-[13px] font-normal">
                              #{item.number}
                            </span>
                          </span>
                        </div>

                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            {item.type === 'pr' ? (
                              <GitPullRequest className="size-4 text-muted-foreground" />
                            ) : (
                              <CircleDot className="size-4 text-muted-foreground" />
                            )}
                            <h3 className="truncate text-[15px] font-semibold text-foreground">
                              {item.title}
                            </h3>
                          </div>
                          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
                            <span>{item.author ?? 'unknown author'}</span>
                            <span>{selectedRepo?.displayName}</span>
                            {item.labels.slice(0, 3).map((label) => (
                              <span
                                key={label}
                                className="rounded-full border border-border/50 bg-background/50 backdrop-blur-md px-2 py-0.5 text-[11px] text-muted-foreground supports-[backdrop-filter]:bg-background/50"
                              >
                                {label}
                              </span>
                            ))}
                          </div>
                        </div>

                        <div className="min-w-0 flex items-center text-sm text-muted-foreground">
                          <span className="truncate">
                            {item.branchName || item.baseRefName || 'workspace/default'}
                          </span>
                        </div>

                        <div className="flex items-center">
                          <span
                            className={cn(
                              'rounded-full border px-2.5 py-1 text-xs font-medium',
                              getTaskStatusTone(item)
                            )}
                          >
                            {getTaskStatusLabel(item)}
                          </span>
                        </div>

                        <Tooltip>
                          <TooltipTrigger asChild>
                            <div className="flex items-center text-sm text-muted-foreground">
                              {formatRelativeTime(item.updatedAt)}
                            </div>
                          </TooltipTrigger>
                          <TooltipContent side="bottom" sideOffset={6}>
                            {new Date(item.updatedAt).toLocaleString()}
                          </TooltipContent>
                        </Tooltip>

                        <div className="flex items-center justify-start gap-1 lg:justify-end">
                          <span className="inline-flex items-center gap-1 rounded-xl border border-border/50 bg-background/50 backdrop-blur-md px-3 py-1.5 text-sm text-foreground supports-[backdrop-filter]:bg-background/50">
                            Use
                            <ArrowRight className="size-4" />
                          </span>
                          <DropdownMenu modal={false}>
                            <DropdownMenuTrigger asChild>
                              <button
                                type="button"
                                onClick={(e) => e.stopPropagation()}
                                className="rounded-lg p-1.5 text-muted-foreground transition hover:bg-muted/60 hover:text-foreground"
                                aria-label="More actions"
                              >
                                <EllipsisVertical className="size-4" />
                              </button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                              <DropdownMenuItem onSelect={() => window.open(item.url, '_blank')}>
                                <ExternalLink className="size-4" />
                                Open in browser
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      </button>
                    )
                  })}
                </div>
              </div>
            </div>
          ) : (
            <div className="mt-4 px-1 py-6">
              <p className="text-sm text-muted-foreground">Coming soon</p>
            </div>
          )}
        </div>
      </div>

      <GitHubItemDrawer
        workItem={drawerWorkItem}
        repoPath={selectedRepo?.path ?? null}
        onUse={(item) => {
          setDrawerWorkItem(null)
          handleSelectWorkItem(item)
        }}
        onClose={() => setDrawerWorkItem(null)}
      />
    </div>
  )
}
