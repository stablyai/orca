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
  Plus,
  RefreshCw,
  Search,
  X
} from 'lucide-react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { useRepoMap } from '@/store/selectors'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import RepoMultiCombobox from '@/components/ui/repo-multi-combobox'
import RepoDotLabel from '@/components/repo/RepoDotLabel'
import { stripRepoQualifiers } from '../../../shared/task-query'
import GitHubItemDrawer from '@/components/GitHubItemDrawer'
import { cn } from '@/lib/utils'
import { getLinkedWorkItemSuggestedName, getTaskPresetQuery } from '@/lib/new-workspace'
import type { LinkedWorkItemSummary } from '@/lib/new-workspace'
import { launchWorkItemDirect } from '@/lib/launch-work-item-direct'
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

export default function TaskPage(): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const pageData = useAppStore((s) => s.taskPageData)
  const closeTaskPage = useAppStore((s) => s.closeTaskPage)
  const activeModal = useAppStore((s) => s.activeModal)
  const repos = useAppStore((s) => s.repos)
  const repoMap = useRepoMap()
  const openModal = useAppStore((s) => s.openModal)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const fetchWorkItemsAcrossRepos = useAppStore((s) => s.fetchWorkItemsAcrossRepos)
  const getCachedWorkItems = useAppStore((s) => s.getCachedWorkItems)
  // Why: in workspace view (a worktree is active) App.tsx hides its
  // full-width titlebar, so this page renders its own 42px titlebar strip to
  // keep the top band continuous with the sidebar header and tab rows. When
  // the sidebar is also collapsed, App.tsx floats its titlebar-left controls
  // (traffic lights, sidebar toggle, agent badge) over our strip — reserve
  // the measured width of those controls on the left so our "Tasks" label
  // never sits behind them. In non-workspace mode App.tsx already owns the
  // top titlebar, so skip our strip to avoid a duplicate band.
  const sidebarOpen = useAppStore((s) => s.sidebarOpen)
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const workspaceActive = activeWorktreeId !== null
  const reserveCollapsedHeaderSpace = workspaceActive && !sidebarOpen

  const eligibleRepos = useMemo(() => repos.filter((repo) => isGitRepoKind(repo)), [repos])

  // Why: initial selection resolution honors (1) an explicit preselection from
  // the caller, (2) the persisted defaultRepoSelection (null = sticky-all,
  // array = curated subset, empty after filter = fall back to all), (3) fall
  // back to "all eligible". An explicit preselection wins so "open tasks for
  // this specific repo" entry points still land on a single-repo view.
  const resolvedInitialSelection = useMemo<ReadonlySet<string>>(() => {
    const preferred = pageData.preselectedRepoId
    if (preferred && eligibleRepos.some((repo) => repo.id === preferred)) {
      return new Set([preferred])
    }
    const persisted = settings?.defaultRepoSelection
    if (Array.isArray(persisted)) {
      const filtered = persisted.filter((id) => eligibleRepos.some((r) => r.id === id))
      if (filtered.length > 0) {
        return new Set(filtered)
      }
      // Why: empty after filtering (e.g. all persisted repos were removed)
      // falls through to "all eligible" so the page never renders with an
      // empty selection — see the multi-combobox invariant.
    }
    return new Set(eligibleRepos.map((r) => r.id))
  }, [eligibleRepos, pageData.preselectedRepoId, settings?.defaultRepoSelection])

  const [repoSelection, setRepoSelection] = useState<ReadonlySet<string>>(resolvedInitialSelection)

  // Why: prune selection when a previously-selected repo is removed, and
  // preserve sticky-all (when the selection equaled every eligible repo
  // pre-change, keep it equal to every eligible repo post-change so "All
  // repos" stays truthful). Recreating the Set every time eligibleRepos
  // changes would churn the fetch effect — only write when the identity of
  // the selection actually needs to change.
  const prevEligibleCountRef = useRef(eligibleRepos.length)
  useEffect(() => {
    const prevCount = prevEligibleCountRef.current
    prevEligibleCountRef.current = eligibleRepos.length
    const eligibleIds = new Set(eligibleRepos.map((r) => r.id))
    const wasAll = repoSelection.size === prevCount && prevCount > 0
    const pruned = new Set<string>()
    for (const id of repoSelection) {
      if (eligibleIds.has(id)) {
        pruned.add(id)
      }
    }
    if (wasAll) {
      const allNow = new Set(eligibleIds)
      if (allNow.size !== repoSelection.size || [...allNow].some((id) => !repoSelection.has(id))) {
        setRepoSelection(allNow)
      }
      return
    }
    if (pruned.size === 0 && eligibleIds.size > 0) {
      setRepoSelection(new Set(eligibleIds))
      return
    }
    if (pruned.size !== repoSelection.size) {
      setRepoSelection(pruned)
    }
  }, [eligibleRepos, repoSelection])

  const selectedRepos = useMemo(
    () => eligibleRepos.filter((r) => repoSelection.has(r.id)),
    [eligibleRepos, repoSelection]
  )

  // Why: many single-repo-only affordances (new-issue dialog target, drawer
  // repo path lookup, optimistic stub) need *a* repo. When exactly one is
  // selected we use it; otherwise we pick the first to keep the UI
  // functional, and disable the single-repo features that don't make sense
  // cross-repo (new-issue button) explicitly.
  const primaryRepo = selectedRepos[0] ?? null
  const isSingleRepo = selectedRepos.length === 1

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
  // Why: per-repo failure count surfaced through the "N of M" banner. IPC-level
  // rejections populate tasksError instead — the two are mutually exclusive so
  // a successful-with-partial-failure read and a hard-reject don't double-show.
  const [failedCount, setFailedCount] = useState(0)
  const [taskRefreshNonce, setTaskRefreshNonce] = useState(0)
  // Why: the fetch effect uses this to detect when a nonce bump is from the
  // user clicking the refresh button (force=true) vs. re-running for any
  // other reason — e.g. a repo change while the nonce happens to be > 0.
  const lastFetchedNonceRef = useRef(-1)
  // Why: seed from the SWR cache across every initially-selected repo so the
  // first paint shows the merged-and-sorted view instantly when all repos are
  // already cached. Any missing cache entry simply contributes nothing here
  // and will be filled in by the effect's fetch.
  const [workItems, setWorkItems] = useState<GitHubWorkItem[]>(() => {
    const trimmed = initialTaskQuery.trim()
    const merged: GitHubWorkItem[] = []
    for (const r of selectedRepos) {
      const cached = getCachedWorkItems(r.path, WORK_ITEM_LIMIT, trimmed)
      if (cached) {
        merged.push(...cached)
      }
    }
    if (merged.length === 0) {
      return []
    }
    return [...merged]
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .slice(0, WORK_ITEM_LIMIT)
  })
  // Why: clicking a GitHub row opens this drawer for a read-only preview.
  // Drawer's "Use" button routes through the same direct-launch flow as the
  // row-level "Use" CTA so behavior is consistent regardless of entry point.
  const [drawerWorkItem, setDrawerWorkItem] = useState<GitHubWorkItem | null>(null)
  const [newIssueOpen, setNewIssueOpen] = useState(false)
  const [newIssueTitle, setNewIssueTitle] = useState('')
  const [newIssueBody, setNewIssueBody] = useState('')
  const [newIssueSubmitting, setNewIssueSubmitting] = useState(false)

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
    if (taskSource !== 'github') {
      return
    }
    if (selectedRepos.length === 0) {
      return
    } // unreachable — multi-combobox forbids empty

    // Why: `repo:owner/name` qualifiers are silently dropped before fan-out
    // because in cross-repo mode they would pin every per-repo fetch to a
    // single repo and zero out the rest. See stripRepoQualifiers.
    const q = stripRepoQualifiers(appliedTaskSearch.trim())
    let cancelled = false

    // Why: paint cached rows synchronously before awaiting the fan-out so
    // selection changes don't leave the previous selection's rows on screen
    // for a frame. Any repo without a cache entry simply contributes nothing
    // to this pre-paint; the fetch will fill it in.
    const preMerged: GitHubWorkItem[] = []
    let anyUncached = false
    for (const r of selectedRepos) {
      const cached = getCachedWorkItems(r.path, WORK_ITEM_LIMIT, q)
      if (cached === null) {
        anyUncached = true
      } else {
        preMerged.push(...cached)
      }
    }
    // Why: always replace — if preMerged is empty (e.g. query just changed and
    // no repo has a cache entry for it), we clear the previous query's rows
    // rather than leaving them on screen under the spinner.
    setWorkItems(
      preMerged.length > 0
        ? [...preMerged]
            .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
            .slice(0, WORK_ITEM_LIMIT)
        : []
    )
    setTasksError(null)
    setFailedCount(0) // reset so a prior failure banner doesn't linger
    setTasksLoading(anyUncached)

    // Preserve the existing nonce-gated force behavior.
    const forceRefresh = taskRefreshNonce !== lastFetchedNonceRef.current
    lastFetchedNonceRef.current = taskRefreshNonce

    const repoArgs = selectedRepos.map((r) => ({ repoId: r.id, path: r.path }))
    void fetchWorkItemsAcrossRepos(repoArgs, WORK_ITEM_LIMIT, q, {
      force: forceRefresh && taskRefreshNonce > 0
    })
      .then(({ items, failedCount: failed }) => {
        if (cancelled) {
          return
        }
        setWorkItems(items)
        setFailedCount(failed)
        setTasksLoading(false)
      })
      .catch((err) => {
        // Why: fetchWorkItemsAcrossRepos swallows per-repo failures, so a
        // reject here means an IPC-level or programmer error — surface it.
        if (cancelled) {
          return
        }
        setTasksError(err instanceof Error ? err.message : 'Failed to load GitHub work.')
        setFailedCount(0) // the per-repo banner would be misleading next to tasksError
        setTasksLoading(false)
      })

    return () => {
      cancelled = true
    }
    // Why: getCachedWorkItems and fetchWorkItemsAcrossRepos are stable zustand
    // selectors; depending on them would re-run the effect on unrelated store
    // updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRepos, appliedTaskSearch, taskRefreshNonce, taskSource])

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

  const openComposerForItem = useCallback(
    (item: GitHubWorkItem): void => {
      const linkedWorkItem: LinkedWorkItemSummary = {
        type: item.type,
        number: item.number,
        title: item.title,
        url: item.url
      }
      openModal('new-workspace-composer', {
        linkedWorkItem,
        prefilledName: getLinkedWorkItemSuggestedName(item),
        initialRepoId: item.repoId
      })
    },
    [openModal]
  )

  const handleUseWorkItem = useCallback(
    (item: GitHubWorkItem): void => {
      // Why: the "Use" CTA is the primary way to start work from this page, so
      // skip the composer for the common case and create+activate the workspace
      // immediately, launch the user's default agent, and paste the work item
      // URL into the agent's input as a reviewable draft. Fall back to the
      // composer modal only when explicit per-workspace decisions are required
      // (setupRunPolicy === 'ask') or the repo/agent resolution fails.
      void launchWorkItemDirect({
        item,
        repoId: item.repoId,
        openModalFallback: () => openComposerForItem(item)
      })
    },
    [openComposerForItem]
  )

  const handleCreateNewIssue = useCallback(async (): Promise<void> => {
    if (!primaryRepo || !isSingleRepo) {
      return
    }
    const title = newIssueTitle.trim()
    if (!title || newIssueSubmitting) {
      return
    }
    setNewIssueSubmitting(true)
    try {
      const result = await window.api.gh.createIssue({
        repoPath: primaryRepo.path,
        title,
        body: newIssueBody
      })
      if (!result.ok) {
        toast.error(result.error || 'Failed to create issue.')
        return
      }
      toast.success(`Opened issue #${result.number}`, {
        action: result.url
          ? {
              label: 'View',
              onClick: () => window.open(result.url, '_blank')
            }
          : undefined
      })
      setNewIssueOpen(false)
      setNewIssueTitle('')
      setNewIssueBody('')
      // Why: bump the nonce so the list refetches and shows the new issue.
      setTaskRefreshNonce((current) => current + 1)

      // Why: auto-open the new issue in the side drawer so the user sees
      // exactly what was filed. Use an optimistic stub first so the drawer
      // has immediate content, then refine with the full `workItem` fetch.
      const stub: GitHubWorkItem = {
        id: `issue:${String(result.number)}`,
        repoId: primaryRepo.id,
        type: 'issue',
        number: result.number,
        title,
        state: 'open',
        url: result.url,
        labels: [],
        updatedAt: new Date().toISOString(),
        author: null
      }
      setDrawerWorkItem(stub)
      const stubRepoId = primaryRepo.id
      void window.api.gh
        .workItem({ repoPath: primaryRepo.path, number: result.number })
        .then((full) => {
          if (full) {
            // Why: `full` is `Omit<GitHubWorkItem, 'repoId'>` (IPC shape).
            // Cast through unknown: spreading a discriminated union loses the
            // discriminant, so `{ ...full, repoId }` doesn't typecheck as
            // GitHubWorkItem. The runtime shape is correct by construction.
            const withRepoId = { ...full, repoId: stubRepoId } as unknown as GitHubWorkItem
            setDrawerWorkItem(withRepoId)
          }
        })
        .catch(() => {})
    } finally {
      setNewIssueSubmitting(false)
    }
  }, [isSingleRepo, newIssueBody, newIssueSubmitting, newIssueTitle, primaryRepo])

  useEffect(() => {
    // Why: when a modal is open, let it own Esc dismissal.
    if (drawerWorkItem || newIssueOpen || activeModal !== 'none') {
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
      closeTaskPage()
    }

    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [activeModal, closeTaskPage, drawerWorkItem, newIssueOpen])

  return (
    <div className="relative flex h-full min-h-0 flex-1 overflow-hidden bg-background text-foreground">
      {/* Why: no z-index here. App.tsx's floating titlebar-left (traffic lights
          + sidebar-expand toggle + agent badge) is absolutely positioned at
          z-10 in the root stacking context when the sidebar is collapsed. If
          this wrapper also sits at z-10 it ties with titlebar-left on
          z-index and wins on DOM order (later sibling), so even though our
          top-left spacer is pointer-events-none, the click still lands on
          this wrapper behind the spacer instead of falling through to the
          sidebar toggle. Keeping this at z-auto lets titlebar-left's z-10
          paint above our content and receive the click cleanly. */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        {/* Why: in workspace view App.tsx suppresses its full-width titlebar,
            so render a matching 42px strip here to keep the top band
            continuous with the sidebar header and tab rows. When the sidebar
            is collapsed, App.tsx floats its titlebar-left controls (traffic
            lights, sidebar toggle, agent badge) over the top-left of this
            page at z-10, and the page wrapper stays at z-auto so that float
            always paints above our content. Keep the reserved region
            transparent so the floating titlebar-left's own bg + border-bottom
            is what the user sees on the left — the two segments then read as
            one continuous band. The painted remainder is a drag-region so the
            window stays movable here, matching other top chrome. Skipped in
            non-workspace mode because App.tsx already owns the top titlebar
            and a second strip would produce a duplicate band. */}
        {workspaceActive ? (
          <div className="flex-none flex h-[42px]">
            {reserveCollapsedHeaderSpace ? (
              // Why: the floating titlebar-left hosts real interactive chrome
              // (sidebar-expand toggle, agent badge) under this segment. Both
              // pointer-events-none AND WebkitAppRegion='no-drag' are needed:
              // without pointer-events-none, this transparent div absorbs
              // clicks before they reach the toggle; without no-drag, Electron
              // marks the area as window-drag and still consumes clicks even
              // when the element itself is click-through.
              <div
                aria-hidden
                className="h-full shrink-0 pointer-events-none"
                style={
                  {
                    width: 'var(--collapsed-sidebar-header-width)',
                    WebkitAppRegion: 'no-drag'
                  } as React.CSSProperties
                }
              />
            ) : null}
            <div
              className="flex h-full flex-1 items-center border-b border-border bg-card px-4 text-sm font-medium text-muted-foreground"
              style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
            >
              <span>Tasks</span>
            </div>
          </div>
        ) : null}

        {/* Why: Close sits in its own row below the titlebar strip so it can
            never overlap the floating macOS traffic lights. Kept left-aligned
            to stay out of the app sidebar on the right edge. */}
        <div className="flex-none flex items-center justify-start px-5 pt-3 pb-1 md:px-8 md:pt-4">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-8 rounded-full"
                onClick={closeTaskPage}
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

        <div className="mx-auto flex w-full flex-1 flex-col min-h-0 px-5 pb-5 md:px-8 md:pb-7">
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
                                'group flex h-8 w-8 items-center justify-center rounded-md border transition',
                                active
                                  ? 'border-foreground/40 bg-muted/70 text-foreground shadow-sm'
                                  : 'border-border/40 bg-transparent text-muted-foreground hover:bg-muted/40 hover:text-foreground',
                                source.disabled && 'cursor-not-allowed opacity-55'
                              )}
                            >
                              <source.Icon className="size-3.5" />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="bottom" sideOffset={6}>
                            {source.label}
                          </TooltipContent>
                        </Tooltip>
                      )
                    })}
                  </div>
                  <div className="w-[200px]">
                    <RepoMultiCombobox
                      repos={eligibleRepos}
                      selected={repoSelection}
                      onChange={(next) => {
                        setRepoSelection(next)
                        // Why: persist the curated subset so the same set reopens
                        // next launch. Sticky-all uses onSelectAll instead.
                        void updateSettings({ defaultRepoSelection: [...next] }).catch(() => {
                          toast.error('Failed to save repo selection.')
                        })
                      }}
                      onSelectAll={() => {
                        const allIds = new Set(eligibleRepos.map((r) => r.id))
                        setRepoSelection(allIds)
                        // Why: persist `null` so new repos added later are
                        // automatically included — a frozen array would exclude them.
                        void updateSettings({ defaultRepoSelection: null }).catch(() => {
                          toast.error('Failed to save repo selection.')
                        })
                      }}
                      triggerClassName="h-8 w-full rounded-md border border-border/50 bg-muted/50 px-2 text-xs font-medium shadow-sm transition hover:bg-muted/50 focus:ring-2 focus:ring-ring/20 focus:outline-none"
                    />
                  </div>
                </div>

                {taskSource === 'github' && (
                  <div className="rounded-md rounded-b-none border border-border/50 bg-muted/50 p-3 shadow-sm">
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
                                'rounded-md border px-2 py-1 text-xs transition',
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
                              onClick={() => {
                                setNewIssueTitle('')
                                setNewIssueBody('')
                                setNewIssueOpen(true)
                              }}
                              disabled={!primaryRepo || !isSingleRepo}
                              aria-label="New GitHub issue"
                              className="border-border/50 bg-transparent hover:bg-muted/50 backdrop-blur-md supports-[backdrop-filter]:bg-transparent"
                            >
                              <Plus className="size-4" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent side="bottom" sideOffset={6}>
                            {isSingleRepo
                              ? 'New GitHub issue'
                              : 'Select a single repo to create an issue'}
                          </TooltipContent>
                        </Tooltip>
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

                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <div className="relative min-w-[320px] flex-1">
                        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                        <Input
                          value={taskSearchInput}
                          onChange={handleTaskSearchChange}
                          onKeyDown={handleTaskSearchKeyDown}
                          placeholder="GitHub search, e.g. assignee:@me is:open"
                          className="h-8 rounded-md border-border/50 bg-background pl-8 pr-8 text-xs"
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
            <div className="flex min-h-0 max-h-full flex-col rounded-md border border-t-0 border-border/50 bg-muted/50 overflow-hidden rounded-t-none shadow-sm">
              <div className="flex-none grid grid-cols-[80px_minmax(0,3fr)_minmax(110px,0.8fr)_100px_110px_80px] gap-3 border-b border-border/50 px-3 py-2 text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
                <span>ID</span>
                <span>Title / Context</span>
                <span>Source Branch</span>
                <span>Status</span>
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

                {!tasksError && failedCount > 0 ? (
                  // Why: per-repo partial-failure signal — distinct from a hard
                  // IPC reject (tasksError). The two are mutually exclusive.
                  <div className="border-b border-border/50 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-200">
                    {failedCount} of {selectedRepos.length} repos failed to load
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
                        className="grid w-full gap-2 px-3 py-2 grid-cols-[80px_minmax(0,3fr)_minmax(110px,0.8fr)_100px_110px_80px]"
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
                    const itemRepo = repoMap.get(item.repoId) ?? null
                    return (
                      // Why: the row is a clickable container rather than a
                      // <button> because it holds nested interactive elements
                      // (Use button, ellipsis DropdownMenuTrigger, Radix
                      // TooltipTrigger). A <button> ancestor of another
                      // <button> is invalid HTML and triggers React hydration
                      // errors that break rendering of the whole page.
                      <div
                        key={item.id}
                        role="button"
                        tabIndex={0}
                        onClick={() => setDrawerWorkItem(item)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault()
                            setDrawerWorkItem(item)
                          }
                        }}
                        className="grid w-full cursor-pointer gap-2 px-3 py-2 text-left transition hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 grid-cols-[80px_minmax(0,3fr)_minmax(110px,0.8fr)_100px_110px_80px]"
                      >
                        <div className="flex items-center">
                          <span className="inline-flex items-center gap-1 rounded-md border border-border/50 bg-muted/40 px-1.5 py-0.5 text-muted-foreground">
                            {item.type === 'pr' ? (
                              <GitPullRequest className="size-3" />
                            ) : (
                              <CircleDot className="size-3" />
                            )}
                            <span className="font-mono text-[11px] font-normal">
                              #{item.number}
                            </span>
                          </span>
                        </div>

                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <h3 className="truncate text-[15px] font-semibold text-foreground">
                              {item.title}
                            </h3>
                            {selectedRepos.length > 1 && itemRepo ? (
                              // Why: disambiguate rows when multiple repos are in
                              // the merged list — a single-repo view doesn't need it.
                              <RepoDotLabel
                                name={itemRepo.displayName}
                                color={itemRepo.badgeColor}
                                dotClassName="size-1.5"
                                className="shrink-0 text-[11px] text-muted-foreground"
                              />
                            ) : null}
                          </div>
                          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
                            <span>{item.author ?? 'unknown author'}</span>
                            {selectedRepos.length === 1 && itemRepo ? (
                              <span>{itemRepo.displayName}</span>
                            ) : null}
                            {item.labels.slice(0, 3).map((label) => (
                              <span
                                key={label}
                                className="rounded-full border border-border/50 bg-background/80 px-1.5 py-0 text-[10px] text-muted-foreground"
                              >
                                {label}
                              </span>
                            ))}
                          </div>
                        </div>

                        <div className="min-w-0 flex items-center text-xs text-muted-foreground">
                          <span className="truncate">
                            {item.branchName || item.baseRefName || 'workspace/default'}
                          </span>
                        </div>

                        <div className="flex items-center">
                          <span
                            className={cn(
                              'rounded-full border px-2 py-0.5 text-[10px] font-medium',
                              getTaskStatusTone(item)
                            )}
                          >
                            {getTaskStatusLabel(item)}
                          </span>
                        </div>

                        <Tooltip>
                          <TooltipTrigger asChild>
                            <div className="flex items-center text-[11px] text-muted-foreground">
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
                              handleUseWorkItem(item)
                            }}
                            className="inline-flex items-center gap-1 rounded-md border border-border/50 bg-background/80 px-2 py-1 text-[11px] text-foreground transition hover:bg-muted/60"
                          >
                            Use
                            <ArrowRight className="size-3" />
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
                      </div>
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

      <Dialog
        open={newIssueOpen}
        onOpenChange={(open) => {
          if (!newIssueSubmitting) {
            setNewIssueOpen(open)
          }
        }}
      >
        <DialogContent
          className="sm:max-w-lg"
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault()
              void handleCreateNewIssue()
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>New GitHub issue</DialogTitle>
            <DialogDescription>
              Opens a new issue in {primaryRepo?.displayName ?? 'this repository'}.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <label className="text-[11px] font-medium text-muted-foreground">Title</label>
              <Input
                autoFocus
                value={newIssueTitle}
                onChange={(e) => setNewIssueTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                    e.preventDefault()
                    void handleCreateNewIssue()
                  }
                }}
                placeholder="Short summary"
                disabled={newIssueSubmitting}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[11px] font-medium text-muted-foreground">
                Description (optional, markdown)
              </label>
              <textarea
                value={newIssueBody}
                onChange={(e) => setNewIssueBody(e.target.value)}
                placeholder="What's going on?"
                rows={6}
                disabled={newIssueSubmitting}
                className="w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 resize-none max-h-60 overflow-y-auto"
              />
            </div>
            <p className="text-[10px] text-muted-foreground">Cmd/Ctrl+Enter to submit.</p>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setNewIssueOpen(false)}
              disabled={newIssueSubmitting}
            >
              Cancel
            </Button>
            <Button
              onClick={() => void handleCreateNewIssue()}
              disabled={
                !primaryRepo || !isSingleRepo || !newIssueTitle.trim() || newIssueSubmitting
              }
            >
              {newIssueSubmitting ? (
                <>
                  <LoaderCircle className="size-4 animate-spin" />
                  Creating…
                </>
              ) : (
                'Create issue'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <GitHubItemDrawer
        workItem={drawerWorkItem}
        repoPath={
          // Why: the drawer is for a single item — resolve its repoPath from the
          // item's own repoId (set when fan-out merged the list) so it works in
          // cross-repo mode too. Reusing the memoized repo map avoids an O(n)
          // scan on every render while the drawer is open.
          drawerWorkItem ? (repoMap.get(drawerWorkItem.repoId)?.path ?? null) : null
        }
        onUse={(item) => {
          setDrawerWorkItem(null)
          handleUseWorkItem(item)
        }}
        onClose={() => setDrawerWorkItem(null)}
      />
    </div>
  )
}
