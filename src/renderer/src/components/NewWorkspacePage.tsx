/* eslint-disable max-lines -- Why: the tasks page keeps the repo selector,
task source controls, and GitHub task list co-located so the wiring between the
selected repo, the task filters, and the work-item list stays readable in one
place while this surface is still evolving. */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import GitHubItemDrawer from '@/components/GitHubItemDrawer'
import { cn } from '@/lib/utils'
import { getLinkedWorkItemSuggestedName, getTaskPresetQuery } from '@/lib/new-workspace'
import type { LinkedWorkItemSummary } from '@/lib/new-workspace'
import { isGitRepoKind } from '../../../shared/repo-kind'
import type { GitHubWorkItem, TaskViewPresetId } from '../../../shared/types'
import { shouldSuppressEnterSubmit } from '@/lib/new-workspace-enter-guard'

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
  { id: 'all', label: 'All', query: getTaskPresetQuery('all') },
  { id: 'issues', label: 'Issues', query: getTaskPresetQuery('issues') },
  { id: 'my-issues', label: 'My Issues', query: getTaskPresetQuery('my-issues') },
  { id: 'review', label: 'Needs My Review', query: getTaskPresetQuery('review') },
  { id: 'prs', label: 'PRs', query: getTaskPresetQuery('prs') },
  { id: 'my-prs', label: 'My PRs', query: getTaskPresetQuery('my-prs') }
]

const TASK_SEARCH_DEBOUNCE_MS = 300
const WORK_ITEM_LIMIT = 36

// Why: Intl.RelativeTimeFormat allocation is non-trivial, and previously we
// built a new formatter per work-item row render. Hoisting to module scope
// means all rows share one instance — zero per-row allocation cost.
const relativeTimeFormatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })

function formatRelativeTime(input: string): string {
  const date = new Date(input)
  if (Number.isNaN(date.getTime())) {
    return 'recently'
  }

  const diffMs = date.getTime() - Date.now()
  const diffMinutes = Math.round(diffMs / 60_000)

  if (Math.abs(diffMinutes) < 60) {
    return relativeTimeFormatter.format(diffMinutes, 'minute')
  }

  const diffHours = Math.round(diffMinutes / 60)
  if (Math.abs(diffHours) < 24) {
    return relativeTimeFormatter.format(diffHours, 'hour')
  }

  const diffDays = Math.round(diffHours / 24)
  return relativeTimeFormatter.format(diffDays, 'day')
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
  const repos = useAppStore((s) => s.repos)
  const activeRepoId = useAppStore((s) => s.activeRepoId)
  const openModal = useAppStore((s) => s.openModal)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const fetchWorkItems = useAppStore((s) => s.fetchWorkItems)
  const getCachedWorkItems = useAppStore((s) => s.getCachedWorkItems)

  const eligibleRepos = useMemo(() => repos.filter((repo) => isGitRepoKind(repo)), [repos])

  // Why: resolve the initial repo from (1) explicit page data, (2) the app's
  // currently active repo, (3) the first eligible repo. Falls back to '' so
  // RepoCombobox renders its placeholder until the user picks one.
  const resolvedInitialRepoId = useMemo(() => {
    const preferred = pageData.preselectedRepoId
    if (preferred && eligibleRepos.some((repo) => repo.id === preferred)) {
      return preferred
    }
    if (activeRepoId && eligibleRepos.some((repo) => repo.id === activeRepoId)) {
      return activeRepoId
    }
    return eligibleRepos[0]?.id ?? ''
  }, [activeRepoId, eligibleRepos, pageData.preselectedRepoId])

  const [repoId, setRepoId] = useState<string>(resolvedInitialRepoId)

  // Why: if the repo list changes such that the current repoId is no longer
  // eligible (e.g. repo removed), fall back to a valid one.
  useEffect(() => {
    if (!repoId && eligibleRepos[0]?.id) {
      setRepoId(eligibleRepos[0].id)
      return
    }
    if (repoId && !eligibleRepos.some((repo) => repo.id === repoId)) {
      setRepoId(eligibleRepos[0]?.id ?? '')
    }
  }, [eligibleRepos, repoId])

  const selectedRepo = eligibleRepos.find((repo) => repo.id === repoId)

  // Why: seed the preset + query from the user's saved default synchronously
  // so the first fetch effect issues exactly one request keyed to the final
  // query. Previously a separate effect "re-seeded" these after mount, which
  // caused a throwaway empty-query fetch followed by a second fetch for the
  // real default — doubling the time-to-first-paint of the list.
  const defaultTaskViewPreset = settings?.defaultTaskViewPreset ?? 'all'
  const initialTaskQuery = getTaskPresetQuery(defaultTaskViewPreset)

  const [taskSource, setTaskSource] = useState<TaskSource>('github')
  const [taskSearchInput, setTaskSearchInput] = useState(initialTaskQuery)
  const [appliedTaskSearch, setAppliedTaskSearch] = useState(initialTaskQuery)
  const [activeTaskPreset, setActiveTaskPreset] = useState<TaskViewPresetId | null>(
    defaultTaskViewPreset
  )
  const [tasksLoading, setTasksLoading] = useState(false)
  const [tasksError, setTasksError] = useState<string | null>(null)
  const [taskRefreshNonce, setTaskRefreshNonce] = useState(0)
  // Why: the fetch effect uses this to detect when a nonce bump is from the
  // user clicking the refresh button (force=true) vs. re-running for any
  // other reason — e.g. a repo change while the nonce happens to be > 0.
  const lastFetchedNonceRef = useRef(-1)
  // Why: seed from the SWR cache so revisiting the page (or opening it after
  // a hover-prefetch) shows the list instantly while the background revalidate
  // keeps it current. Falls back to [] when nothing is cached yet.
  const [workItems, setWorkItems] = useState<GitHubWorkItem[]>(() => {
    if (!selectedRepo) {
      return []
    }
    return getCachedWorkItems(selectedRepo.path, WORK_ITEM_LIMIT, initialTaskQuery.trim()) ?? []
  })
  // Why: clicking a GitHub row opens this drawer for a read-only preview.
  // The composer modal is only opened by the drawer's "Use" button, which
  // calls the same handleSelectWorkItem as the old direct row-click flow.
  const [drawerWorkItem, setDrawerWorkItem] = useState<GitHubWorkItem | null>(null)

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

    const trimmedQuery = appliedTaskSearch.trim()
    const repoPath = selectedRepo.path

    // Why: SWR — render cached items instantly, then revalidate in the
    // background. Only show the spinner when we have nothing cached, so
    // repeat visits feel instant instead of flashing a loading state.
    const cached = getCachedWorkItems(repoPath, WORK_ITEM_LIMIT, trimmedQuery)
    if (cached) {
      setWorkItems(cached)
      setTasksError(null)
      setTasksLoading(false)
    } else {
      setTasksLoading(true)
      setTasksError(null)
    }

    let cancelled = false
    // Why: force a refetch only when the nonce has incremented since the last
    // fetch (i.e. the user hit the refresh button or clicked a preset). Other
    // triggers — repo changes, search-box edits — should respect the SWR
    // cache's TTL instead of hammering `gh` on every keystroke.
    const forceRefresh = taskRefreshNonce !== lastFetchedNonceRef.current
    lastFetchedNonceRef.current = taskRefreshNonce

    // Why: the buttons below populate the same search bar the user can edit by
    // hand, so the fetch path has to honor both the preset GitHub query and any
    // ad-hoc qualifiers the user types (for example assignee:@me). The fetch is
    // debounced through `appliedTaskSearch` so backspacing all the way to empty
    // refires the query without spamming GitHub on every keystroke.
    void fetchWorkItems(repoPath, WORK_ITEM_LIMIT, trimmedQuery, {
      force: forceRefresh && taskRefreshNonce > 0
    })
      .then((items) => {
        if (!cancelled) {
          setWorkItems(items)
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setTasksError(error instanceof Error ? error.message : 'Failed to load GitHub work.')
          if (!cached) {
            setWorkItems([])
          }
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
    // Why: getCachedWorkItems is a stable zustand selector; depending on it
    // would cause unnecessary effect re-runs on unrelated store updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appliedTaskSearch, selectedRepo, taskRefreshNonce, taskSource, fetchWorkItems])

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
        // React SyntheticEvent does not expose isComposing; use nativeEvent.
        if (
          shouldSuppressEnterSubmit(
            { isComposing: event.nativeEvent.isComposing, shiftKey: event.shiftKey },
            false
          )
        ) {
          return
        }
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

  useEffect(() => {
    // Why: when the GitHub preview sheet is open, Radix's Dialog owns Esc —
    // it closes the sheet on its own. Page-level capture would otherwise fire
    // first and pop the tasks page while the user just meant to dismiss the
    // preview.
    if (drawerWorkItem) {
      return
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') {
        return
      }

      const target = event.target
      if (!(target instanceof HTMLElement)) {
        return
      }

      // Why: Esc should first dismiss the focused control so users can back
      // out of text entry without accidentally closing the whole page.
      // Once focus is already outside an input, Esc closes the tasks page.
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
      closeNewWorkspacePage()
    }

    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [closeNewWorkspacePage, drawerWorkItem])

  return (
    <div className="relative flex h-full min-h-0 flex-1 overflow-hidden bg-background text-foreground">
      <div className="relative z-10 flex min-h-0 flex-1 flex-col">
        {/* Why: left-aligned so it doesn't collide with the app sidebar on the
            right edge. The GitHub preview is a modal sheet that overlays the
            whole surface, so this button is hidden behind it while it's open. */}
        <div className="flex-none flex items-center justify-start px-5 py-3 md:px-8 md:py-4">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-8 rounded-full z-10"
                onClick={closeNewWorkspacePage}
                aria-label="Close tasks"
              >
                <X className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              Close · Esc
            </TooltipContent>
          </Tooltip>
        </div>

        <div className="mx-auto flex w-full max-w-[1120px] flex-1 flex-col min-h-0 px-5 pb-5 md:px-8 md:pb-7">
          <div className="flex-none flex flex-col gap-5">
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
                                  ? 'border-border bg-muted/70 shadow-sm'
                                  : 'border-border/70 bg-muted/30 hover:bg-muted/60 hover:border-border',
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
                      onValueChange={setRepoId}
                      placeholder="Select a repository"
                      triggerClassName="h-11 w-full rounded-[10px] border border-border/50 bg-muted/50 px-3 text-sm font-medium shadow-sm transition hover:bg-muted/50 focus:ring-2 focus:ring-ring/20 focus:outline-none"
                    />
                  </div>
                </div>

                {taskSource === 'github' && (
                  <div className="rounded-[16px] border border-border/50 bg-muted/50 p-4 shadow-sm">
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
                          className="h-10 border-border/50 bg-background pl-10 pr-10"
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
            <div className="mt-4 flex min-h-0 max-h-full flex-col rounded-[16px] border border-border/50 bg-muted/50 overflow-hidden shadow-sm">
              <div className="flex-none hidden grid-cols-[96px_minmax(0,1.8fr)_minmax(140px,1fr)_150px_120px_90px] gap-4 border-b border-border/50 px-4 py-3 text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground lg:grid">
                <span>ID</span>
                <span>Title / Context</span>
                <span>Source Branch</span>
                <span>System Status</span>
                <span>Updated</span>
                <span />
              </div>

              <div
                className="min-h-0 flex-initial overflow-y-auto scrollbar-sleek"
                style={{ scrollbarGutter: 'stable' }}
              >
                {tasksError ? (
                  <div className="border-b border-border px-4 py-4 text-sm text-destructive">
                    {tasksError}
                  </div>
                ) : null}

                {tasksLoading && filteredWorkItems.length === 0 ? (
                  // Why: shimmer skeleton stands in for the first ~3 rows while
                  // the initial fetch is in flight, so the card is never empty
                  // or collapsed during load. Only shown when we have no cached
                  // items — on revalidate we keep the stale list visible.
                  <div className="divide-y divide-border/50">
                    {Array.from({ length: 3 }).map((_, i) => (
                      <div
                        key={i}
                        className="grid w-full gap-4 px-4 py-4 lg:grid-cols-[96px_minmax(0,1.8fr)_minmax(140px,1fr)_150px_120px_90px]"
                      >
                        <div className="flex items-center">
                          <div className="h-7 w-16 animate-pulse rounded-lg bg-muted/70" />
                        </div>
                        <div className="min-w-0">
                          <div className="h-4 w-3/5 animate-pulse rounded bg-muted/70" />
                          <div className="mt-2 h-3 w-2/5 animate-pulse rounded bg-muted/60" />
                        </div>
                        <div className="flex items-center">
                          <div className="h-3 w-24 animate-pulse rounded bg-muted/60" />
                        </div>
                        <div className="flex items-center">
                          <div className="h-5 w-14 animate-pulse rounded-full bg-muted/70" />
                        </div>
                        <div className="flex items-center">
                          <div className="h-3 w-20 animate-pulse rounded bg-muted/60" />
                        </div>
                        <div className="flex items-center justify-start lg:justify-end">
                          <div className="h-7 w-16 animate-pulse rounded-xl bg-muted/70" />
                        </div>
                      </div>
                    ))}
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
                          {/* Why: "Use" is the primary CTA — it should open
                              the composer directly, skipping the read-only
                              drawer that the row-click opens for previewing.
                              Stop propagation so the row-level button that
                              owns this grid doesn't also toggle the drawer. */}
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation()
                              handleSelectWorkItem(item)
                            }}
                            className="inline-flex items-center gap-1 rounded-xl border border-border/50 bg-background/50 backdrop-blur-md px-3 py-1.5 text-sm text-foreground transition hover:bg-muted/60 supports-[backdrop-filter]:bg-background/50"
                          >
                            Use
                            <ArrowRight className="size-4" />
                          </button>
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
