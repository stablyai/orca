/* eslint-disable max-lines -- Why: the tasks page keeps the repo selector,
task source controls, and GitHub task list co-located so the wiring between the
selected repo, the task filters, and the work-item list stays readable in one
place while this surface is still evolving. */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  ArrowRight,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleDot,
  EllipsisVertical,
  ExternalLink,
  Github,
  Gitlab,
  GitPullRequest,
  LoaderCircle,
  Lock,
  Plus,
  RefreshCw,
  Search,
  X
} from 'lucide-react'
import { toast } from 'sonner'

import { useAppStore } from '@/store'
import { useRepoMap } from '@/store/selectors'
import { callRuntimeRpc, getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
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
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import RepoMultiCombobox from '@/components/ui/repo-multi-combobox'
import TeamMultiCombobox from '@/components/ui/team-multi-combobox'
import RepoDotLabel from '@/components/repo/RepoDotLabel'
import IssueSourceIndicator, { sameGitHubOwnerRepo } from '@/components/github/IssueSourceIndicator'
import IssueSourceSelector, { issueSourceChipClass } from '@/components/github/IssueSourceSelector'
import GitHubRateLimitPill from '@/components/github/GitHubRateLimitPill'
import { stripRepoQualifiers } from '../../../shared/task-query'
import GitHubItemDialog from '@/components/GitHubItemDialog'
import GitLabItemDialog from '@/components/GitLabItemDialog'
import ProjectViewWrapper from '@/components/github-project/ProjectViewWrapper'
import LinearItemDrawer from '@/components/LinearItemDrawer'
import { cn } from '@/lib/utils'
import {
  getLinkedWorkItemSuggestedName,
  getTaskPresetQuery,
  PER_REPO_FETCH_LIMIT,
  CROSS_REPO_DISPLAY_LIMIT
} from '@/lib/new-workspace'
import type { LinkedWorkItemSummary } from '@/lib/new-workspace'
import { isGitRepoKind } from '../../../shared/repo-kind'
import { useTeamStates } from '@/hooks/useIssueMetadata'
import {
  buildTaskPageRepoSourceState,
  findTaskPageDialogWorkItem,
  findTaskPageLinearDrawerIssue,
  selectTaskPageWorkItemsCacheEntries,
  type TaskPageRepoSourceState
} from '@/components/task-page-cache-selectors'
import type {
  GitHubOwnerRepo,
  GitHubWorkItem,
  GitLabTodo,
  GitLabWorkItem,
  LinearIssue,
  LinearTeam,
  Repo,
  TaskViewPresetId
} from '../../../shared/types'
import { shouldSuppressEnterSubmit } from '@/lib/new-workspace-enter-guard'
import {
  linearCreateIssue,
  linearGetIssue,
  linearListTeams,
  linearUpdateIssue
} from '@/runtime/runtime-linear-client'

type TaskSource = 'github' | 'linear' | 'gitlab'

type GitLabTaskFilter = 'opened' | 'merged' | 'closed' | 'all'

const GITLAB_TASK_FILTERS: { id: GitLabTaskFilter; label: string }[] = [
  { id: 'opened', label: 'Open' },
  { id: 'merged', label: 'Merged' },
  { id: 'closed', label: 'Closed' },
  { id: 'all', label: 'All' }
]
type TaskQueryPreset = {
  id: TaskViewPresetId
  label: string
  query: string
}

function getRuntimeTargetForRepoId(repoId: string | null | undefined) {
  if (!repoId) {
    return null
  }
  const state = useAppStore.getState()
  const target = getActiveRuntimeTarget(state.settings)
  if (target.kind !== 'environment') {
    return null
  }
  return state.repos.some((repo) => repo.id === repoId) ? target : null
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
    id: 'gitlab',
    label: 'GitLab',
    Icon: ({ className }) => <Gitlab className={className} />
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

type LinearPresetId = 'assigned' | 'created' | 'all' | 'completed'
type LinearPreset = { id: LinearPresetId; label: string }

const LINEAR_PRESETS: LinearPreset[] = [
  { id: 'all', label: 'All' },
  { id: 'assigned', label: 'My Issues' },
  { id: 'created', label: 'Created' },
  { id: 'completed', label: 'Completed' }
]

const TASK_SEARCH_DEBOUNCE_MS = 300
const LINEAR_ITEM_LIMIT = 36

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

// Why: Linear encodes priority as an integer (0–4). Map to human-readable
// labels so the table column is scannable without memorising the scale.
const LINEAR_PRIORITY_LABELS: Record<number, string> = {
  0: 'None',
  1: 'Urgent',
  2: 'High',
  3: 'Medium',
  4: 'Low'
}

function GHStatusCell({
  item,
  repo
}: {
  item: GitHubWorkItem
  repo: Repo | null
}): React.JSX.Element {
  const patchWorkItem = useAppStore((s) => s.patchWorkItem)
  const [localState, setLocalState] = useState(item.state)
  const [open, setOpen] = useState(false)
  const reqRef = useRef(0)

  useEffect(() => {
    setLocalState(item.state)
  }, [item.state])

  const handleStateChange = useCallback(
    (newState: 'open' | 'closed') => {
      if (newState === localState || !repo || item.type !== 'issue') {
        return
      }
      reqRef.current += 1
      const reqId = reqRef.current
      setLocalState(newState)
      patchWorkItem(item.id, { state: newState })
      const target = getActiveRuntimeTarget(useAppStore.getState().settings)
      const updatePromise =
        target.kind === 'environment'
          ? callRuntimeRpc<{ ok?: boolean; error?: string }>(
              target,
              'github.updateIssue',
              { repo: repo.id, number: item.number, updates: { state: newState } },
              { timeoutMs: 30_000 }
            )
          : window.api.gh.updateIssue({
              repoPath: repo.path,
              repoId: repo.id,
              number: item.number,
              updates: { state: newState }
            })
      updatePromise
        .then((result) => {
          if (reqId !== reqRef.current) {
            return
          }
          const typed = result as { ok?: boolean; error?: string }
          if (typed && typed.ok === false) {
            setLocalState(newState === 'closed' ? 'open' : 'closed')
            patchWorkItem(item.id, { state: newState === 'closed' ? 'open' : 'closed' })
            toast.error(typed.error ?? 'Failed to update state')
          }
        })
        .catch(() => {
          if (reqId !== reqRef.current) {
            return
          }
          setLocalState(newState === 'closed' ? 'open' : 'closed')
          patchWorkItem(item.id, { state: newState === 'closed' ? 'open' : 'closed' })
          toast.error('Failed to update state')
        })
    },
    [item.id, item.number, item.type, localState, repo, patchWorkItem]
  )

  if (item.type !== 'issue' || !repo) {
    return (
      <span
        className={cn(
          'rounded-full border px-2 py-0.5 text-[10px] font-medium opacity-70',
          getTaskStatusTone(item)
        )}
      >
        {getTaskStatusLabel(item)}
      </span>
    )
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          onClick={(e) => e.stopPropagation()}
          className={cn(
            'group/status inline-flex items-center gap-0.5 rounded-full border px-2 py-0.5 text-[10px] font-medium transition hover:brightness-125 hover:ring-1 hover:ring-white/10',
            localState === 'closed'
              ? 'border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-300'
              : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300'
          )}
        >
          {localState === 'closed' ? 'Closed' : 'Open'}
          <ChevronDown className="size-2.5 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-36 p-1" align="start" onClick={(e) => e.stopPropagation()}>
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
          <CircleDot className="size-3 text-emerald-500" />
          Open
        </button>
        <button
          type="button"
          onClick={() => {
            handleStateChange('closed')
            setOpen(false)
          }}
          className={cn(
            'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-[12px] hover:bg-accent',
            localState === 'closed' && 'bg-accent/50'
          )}
        >
          <CircleDot className="size-3 text-rose-500" />
          Closed
        </button>
      </PopoverContent>
    </Popover>
  )
}

function LinearStatusCell({ issue }: { issue: LinearIssue }): React.JSX.Element {
  const patchLinearIssue = useAppStore((s) => s.patchLinearIssue)
  const fetchLinearIssue = useAppStore((s) => s.fetchLinearIssue)
  const settings = useAppStore((s) => s.settings)
  const [localState, setLocalState] = useState(issue.state)
  const reqRef = useRef(0)

  useEffect(() => {
    setLocalState(issue.state)
  }, [issue.state])

  const teamId = issue.team?.id || null
  const states = useTeamStates(teamId, settings, issue.workspaceId)

  const handleStateChange = useCallback(
    (stateId: string) => {
      const newState = states.data.find((s) => s.id === stateId)
      if (!newState) {
        return
      }

      const stateValue = { name: newState.name, type: newState.type, color: newState.color }
      reqRef.current += 1
      const reqId = reqRef.current

      setLocalState(stateValue)
      patchLinearIssue(issue.id, { state: stateValue })
      linearUpdateIssue(settings, issue.id, { stateId }, issue.workspaceId)
        .then((result) => {
          if (reqId !== reqRef.current) {
            return
          }
          const typed = result as { ok?: boolean; error?: string }
          if (typed && typed.ok === false) {
            setLocalState(issue.state)
            patchLinearIssue(issue.id, { state: issue.state })
            toast.error(typed.error ?? 'Failed to update status')
          } else {
            fetchLinearIssue(issue.id, issue.workspaceId)
          }
        })
        .catch(() => {
          if (reqId !== reqRef.current) {
            return
          }
          setLocalState(issue.state)
          patchLinearIssue(issue.id, { state: issue.state })
          toast.error('Failed to update status')
        })
    },
    [
      issue.id,
      issue.state,
      issue.workspaceId,
      settings,
      states.data,
      patchLinearIssue,
      fetchLinearIssue
    ]
  )

  const currentStateId = states.data.find(
    (s) => s.name === localState.name && s.type === localState.type
  )?.id

  const [open, setOpen] = useState(false)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          onClick={(e) => e.stopPropagation()}
          disabled={states.loading}
          className="group/status flex items-center gap-1.5 rounded-sm px-1 py-0.5 transition hover:bg-muted/60 disabled:opacity-50"
        >
          <span
            className="inline-block size-2 shrink-0 rounded-full"
            style={{ backgroundColor: localState.color }}
          />
          <span className="truncate text-xs text-muted-foreground">{localState.name}</span>
          <ChevronDown className="size-2.5 shrink-0 text-muted-foreground opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="popover-scroll-content scrollbar-sleek w-48 p-1"
        align="start"
        onClick={(e) => e.stopPropagation()}
      >
        <div>
          {states.data.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => {
                handleStateChange(s.id)
                setOpen(false)
              }}
              className={cn(
                'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-[12px] hover:bg-accent',
                currentStateId === s.id && 'bg-accent/50'
              )}
            >
              <span
                className="inline-block size-2 rounded-full"
                style={{ backgroundColor: s.color }}
              />
              {s.name}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}

function LinearPriorityCell({ issue }: { issue: LinearIssue }): React.JSX.Element {
  const patchLinearIssue = useAppStore((s) => s.patchLinearIssue)
  const fetchLinearIssue = useAppStore((s) => s.fetchLinearIssue)
  const settings = useAppStore((s) => s.settings)
  const [localPriority, setLocalPriority] = useState(issue.priority)
  const [pending, setPending] = useState(false)
  const reqRef = useRef(0)

  useEffect(() => {
    setLocalPriority(issue.priority)
  }, [issue.priority])

  const handlePriorityChange = useCallback(
    (priority: number) => {
      if (priority === localPriority) {
        return
      }
      reqRef.current += 1
      const reqId = reqRef.current
      setLocalPriority(priority)
      patchLinearIssue(issue.id, { priority })
      setPending(true)
      linearUpdateIssue(settings, issue.id, { priority }, issue.workspaceId)
        .then((result) => {
          if (reqId !== reqRef.current) {
            return
          }
          const typed = result as { ok?: boolean; error?: string }
          if (typed && typed.ok === false) {
            setLocalPriority(issue.priority)
            patchLinearIssue(issue.id, { priority: issue.priority })
            toast.error(typed.error ?? 'Failed to update priority')
          } else {
            fetchLinearIssue(issue.id, issue.workspaceId)
          }
        })
        .catch(() => {
          if (reqId !== reqRef.current) {
            return
          }
          setLocalPriority(issue.priority)
          patchLinearIssue(issue.id, { priority: issue.priority })
          toast.error('Failed to update priority')
        })
        .finally(() => {
          if (reqId !== reqRef.current) {
            return
          }
          setPending(false)
        })
    },
    [
      issue.id,
      issue.priority,
      issue.workspaceId,
      localPriority,
      settings,
      patchLinearIssue,
      fetchLinearIssue
    ]
  )

  const [open, setOpen] = useState(false)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          onClick={(e) => e.stopPropagation()}
          disabled={pending}
          className="group/priority inline-flex items-center gap-0.5 rounded-sm px-1 py-0.5 text-xs text-muted-foreground transition hover:bg-muted/60 disabled:opacity-50"
        >
          {LINEAR_PRIORITY_LABELS[localPriority] ?? `P${localPriority}`}
          {pending ? (
            <LoaderCircle className="ml-1 inline size-3 animate-spin" />
          ) : (
            <ChevronDown className="size-2.5 shrink-0 opacity-50" />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-36 p-1" align="start" onClick={(e) => e.stopPropagation()}>
        {[0, 1, 2, 3, 4].map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => {
              handlePriorityChange(p)
              setOpen(false)
            }}
            className={cn(
              'flex w-full items-center rounded-sm px-2 py-1.5 text-[12px] hover:bg-accent',
              localPriority === p && 'bg-accent/50'
            )}
          >
            {LINEAR_PRIORITY_LABELS[p]}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  )
}

// Why: builds the page number array with ellipsis gaps, matching GitHub's
// pagination pattern: always show first page, last page, and a window of
// pages around the current page with "..." gaps between distant ranges.
function getPageNumbers(current: number, total: number): (number | 'ellipsis')[] {
  if (total <= 9) {
    return Array.from({ length: total }, (_, i) => i)
  }
  const pages = new Set<number>()
  pages.add(0)
  pages.add(total - 1)
  for (let i = Math.max(0, current - 2); i <= Math.min(total - 1, current + 2); i++) {
    pages.add(i)
  }
  const sorted = [...pages].sort((a, b) => a - b)
  const result: (number | 'ellipsis')[] = []
  for (let i = 0; i < sorted.length; i++) {
    if (i > 0 && sorted[i] - sorted[i - 1] > 1) {
      result.push('ellipsis')
    }
    result.push(sorted[i])
  }
  return result
}

function PaginationBar({
  currentPage,
  totalPages,
  loadingTarget,
  onPageChange
}: {
  currentPage: number
  totalPages: number
  loadingTarget: number | null
  onPageChange: (page: number) => void
}): React.JSX.Element {
  const pageNumbers = getPageNumbers(currentPage, totalPages)
  const btnClass =
    'inline-flex items-center gap-0.5 rounded-md px-2 py-1 text-sm text-muted-foreground transition hover:bg-muted/60 hover:text-foreground disabled:pointer-events-none disabled:opacity-40'
  const numClass = (page: number): string =>
    cn(
      'inline-flex size-8 items-center justify-center rounded-md text-sm transition',
      page === currentPage
        ? 'bg-primary text-primary-foreground font-medium'
        : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
    )

  return (
    <nav
      aria-label="Pagination"
      className="flex items-center justify-center gap-1 border-t border-border/50 px-4 py-3"
    >
      <button
        type="button"
        disabled={currentPage === 0 || loadingTarget !== null}
        onClick={() => onPageChange(currentPage - 1)}
        aria-label="Previous page"
        className={btnClass}
      >
        <ChevronLeft className="size-4" />
        Previous
      </button>

      {pageNumbers.map((entry, idx) =>
        entry === 'ellipsis' ? (
          <span
            key={`ellipsis-${idx}`}
            aria-hidden
            className="inline-flex size-8 items-center justify-center text-sm text-muted-foreground"
          >
            &hellip;
          </span>
        ) : (
          <button
            key={entry}
            type="button"
            disabled={loadingTarget !== null && loadingTarget !== entry}
            onClick={() => onPageChange(entry)}
            aria-label={`Page ${entry + 1}`}
            aria-current={entry === currentPage ? 'page' : undefined}
            className={numClass(entry)}
          >
            {loadingTarget === entry ? (
              <LoaderCircle className="size-3.5 animate-spin" />
            ) : (
              entry + 1
            )}
          </button>
        )
      )}

      <button
        type="button"
        disabled={currentPage >= totalPages - 1 || loadingTarget !== null}
        onClick={() => onPageChange(currentPage + 1)}
        aria-label="Next page"
        className={btnClass}
      >
        Next
        <ChevronRight className="size-4" />
      </button>
    </nav>
  )
}

// Why: type-guard predicate used to filter `perRepoSourceState` down to rows
// whose issue-source and PR-source slugs differ. Hoisted to module scope so
// the predicate isn't re-allocated on every TaskPage render.
const hasDivergentSources = (
  s: TaskPageRepoSourceState
): s is TaskPageRepoSourceState & {
  sources: { issues: GitHubOwnerRepo; prs: GitHubOwnerRepo }
} => !!s.sources?.issues && !!s.sources.prs && !sameGitHubOwnerRepo(s.sources.issues, s.sources.prs)

// Why: the selector keeps rendering even after the user picks 'origin' (which
// collapses `sources.issues` onto origin). Upstream-candidate divergence is
// the right render gate — a repo that has an `upstream` remote pointing
// somewhere different from origin is always a candidate for the toggle,
// regardless of the current effective preference.
const hasUpstreamCandidateDivergence = (
  s: TaskPageRepoSourceState
): s is TaskPageRepoSourceState & {
  sources: { prs: GitHubOwnerRepo; upstreamCandidate: GitHubOwnerRepo }
} =>
  !!s.sources?.prs &&
  !!s.sources.upstreamCandidate &&
  !sameGitHubOwnerRepo(s.sources.prs, s.sources.upstreamCandidate)

export default function TaskPage(): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const persistedUIReady = useAppStore((s) => s.persistedUIReady)
  const taskResumeState = useAppStore((s) => s.taskResumeState)
  const setTaskResumeState = useAppStore((s) => s.setTaskResumeState)
  const pageData = useAppStore((s) => s.taskPageData)
  const closeTaskPage = useAppStore((s) => s.closeTaskPage)
  const activeModal = useAppStore((s) => s.activeModal)
  const repos = useAppStore((s) => s.repos)
  const repoMap = useRepoMap()
  const openModal = useAppStore((s) => s.openModal)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const fetchWorkItemsAcrossRepos = useAppStore((s) => s.fetchWorkItemsAcrossRepos)
  const getCachedWorkItems = useAppStore((s) => s.getCachedWorkItems)
  const setIssueSourcePreference = useAppStore((s) => s.setIssueSourcePreference)
  // Why: bumped by `setIssueSourcePreference` after cache eviction so the
  // fetch effect below re-runs and repopulates work-items against the new
  // source. Eviction alone isn't enough because the effect's deps don't
  // include `workItemsCache`.
  const workItemsInvalidationNonce = useAppStore((s) => s.workItemsInvalidationNonce)
  const linearStatus = useAppStore((s) => s.linearStatus)
  const linearStatusChecked = useAppStore((s) => s.linearStatusChecked)
  const connectLinear = useAppStore((s) => s.connectLinear)
  const selectLinearWorkspace = useAppStore((s) => s.selectLinearWorkspace)
  const searchLinearIssues = useAppStore((s) => s.searchLinearIssues)
  const listLinearIssues = useAppStore((s) => s.listLinearIssues)
  const checkLinearConnection = useAppStore((s) => s.checkLinearConnection)
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

  // Why: many affordances (new-issue dialog default, item dialog repo path lookup,
  // optimistic stub) need *a* repo. First selected is used as the default;
  // cross-repo dialogs still let the user override per-action.
  const primaryRepo = selectedRepos[0] ?? null
  const linearWorkspaces = linearStatus.workspaces ?? []
  const selectedLinearWorkspaceId =
    linearStatus.selectedWorkspaceId ??
    linearStatus.activeWorkspaceId ??
    linearWorkspaces[0]?.id ??
    null

  // Why: seed the preset + query from the user's saved default synchronously
  // so the first fetch effect issues exactly one request keyed to the final
  // query. Previously a separate effect "re-seeded" these after mount, which
  // caused a throwaway empty-query fetch followed by a second fetch for the
  // real default — doubling the time-to-first-paint of the list.
  const defaultTaskViewPreset = settings?.defaultTaskViewPreset ?? 'all'
  const initialTaskQuery = getTaskPresetQuery(defaultTaskViewPreset)

  const defaultTaskSource = settings?.defaultTaskSource ?? 'github'
  const [taskSource, setTaskSource] = useState<TaskSource>(pageData.taskSource ?? defaultTaskSource)
  const taskResumeAppliedRef = useRef(false)
  const githubSearchPersistReadyRef = useRef(false)
  const linearSearchPersistReadyRef = useRef(false)
  const [taskResumeApplied, setTaskResumeApplied] = useState(false)

  // Why: pageData.taskSource changes when the user clicks a specific source
  // icon in the sidebar while the task page is already open. useState only
  // initializes once, so sync from the store when the value changes.
  useEffect(() => {
    if (pageData.taskSource) {
      setTaskSource(pageData.taskSource)
    }
  }, [pageData.taskSource])

  // Why: Project mode is a sub-tab within the GitHub source. Visible whenever
  // the user is on the GitHub task source — actual entry into Project mode is
  // gated on a non-null `activeProject` once they pick one.
  const projectModeVisible = taskSource === 'github'
  const [githubMode, setGithubMode] = useState<'items' | 'project'>('items')

  // ── GitLab task-source state ──────────────────────────────────────
  // Why: parallel to Linear's slim per-source state. Skips workItemsCache
  // and cross-repo aggregation in v1 — the GitLab list fetches directly
  // from `window.api.gl.listMRs` / `listIssues` for the primary repo.
  const [gitlabFilter, setGitlabFilter] = useState<GitLabTaskFilter>('opened')
  const [gitlabItems, setGitlabItems] = useState<GitLabWorkItem[]>([])
  const [gitlabLoading, setGitlabLoading] = useState(false)
  const [gitlabError, setGitlabError] = useState<string | null>(null)
  const [gitlabRefreshNonce, setGitlabRefreshNonce] = useState(0)
  // Why: opens GitLabItemDialog when a row is clicked. Separate state from
  // gitlabItems so the dialog target survives a list refresh that might
  // remove the item from the visible filter (e.g. closing an MR while
  // it's open in the dialog).
  const [gitlabDialogItem, setGitlabDialogItem] = useState<GitLabWorkItem | null>(null)

  // Why: GitLab tab has two sub-views — the project's MR/issue list,
  // and the user's cross-project Todos (gitlab.com/dashboard/todos).
  // 'project' is default; 'todos' fetches a separate stream.
  const [gitlabView, setGitlabView] = useState<'project' | 'todos'>('project')
  const [gitlabTodos, setGitlabTodos] = useState<GitLabTodo[]>([])
  const [gitlabTodosLoading, setGitlabTodosLoading] = useState(false)

  const [taskSearchInput, setTaskSearchInput] = useState(initialTaskQuery)
  const [appliedTaskSearch, setAppliedTaskSearch] = useState(initialTaskQuery)
  const taskSearchInputRef = useRef<HTMLInputElement>(null)
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
  // Why: analogous to `lastFetchedNonceRef` for the invalidation nonce. A
  // preference flip should force the dispatch past fetch-dedupe (same repos +
  // same query, cache just evicted — without `force: true` the fan-out could
  // collapse onto a stale in-flight request that resolved against the
  // pre-flip source).
  const lastFetchedInvalidationNonceRef = useRef(0)
  // Why: pages holds all fetched pages of work items. Page 0 is seeded from
  // cache for instant first paint; subsequent pages are loaded via date cursors.
  const [pages, setPages] = useState<GitHubWorkItem[][]>(() => {
    const trimmed = initialTaskQuery.trim()
    const merged: GitHubWorkItem[] = []
    for (const r of selectedRepos) {
      const cached = getCachedWorkItems(r.id, PER_REPO_FETCH_LIMIT, trimmed)
      if (cached) {
        merged.push(...cached)
      }
    }
    if (merged.length === 0) {
      return [[]]
    }
    const page0 = [...merged]
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .slice(0, CROSS_REPO_DISPLAY_LIMIT)
    return [page0]
  })
  const [currentPage, setCurrentPage] = useState(0)
  const [paginationLoading, setPaginationLoading] = useState(false)
  const [loadingTargetPage, setLoadingTargetPage] = useState<number | null>(null)
  const [totalItemCount, setTotalItemCount] = useState<number | null>(null)
  const fetchWorkItemsNextPage = useAppStore((s) => s.fetchWorkItemsNextPage)
  const countWorkItemsAcrossRepos = useAppStore((s) => s.countWorkItemsAcrossRepos)

  // Why: clicking a GitHub row (or completing the create-issue flow) opens
  // this dialog for a read/review surface. The dialog's "Use" button routes
  // through the same direct-launch flow as the row-level "Use" CTA so
  // behavior is consistent regardless of entry point.
  const [dialogWorkItemKey, setDialogWorkItemKey] = useState<{
    id: string
    repoId: string
  } | null>(null)
  const [dialogWorkItemFallback, setDialogWorkItemFallback] = useState<GitHubWorkItem | null>(null)

  const appliedWorkItemsCacheQuery = useMemo(
    () => stripRepoQualifiers(appliedTaskSearch.trim()),
    [appliedTaskSearch]
  )
  const selectedWorkItemsCacheEntries = useAppStore(
    useShallow((s) =>
      selectTaskPageWorkItemsCacheEntries(
        s.workItemsCache,
        selectedRepos,
        PER_REPO_FETCH_LIMIT,
        appliedWorkItemsCacheQuery
      )
    )
  )

  // Why: derive the dialog's work item from the store cache so it reflects
  // optimistic patches (e.g. table-cell status toggle). Falls back to the
  // snapshot stored at click time for newly-created stubs not yet in the cache.
  // Disambiguates by repoId so issues with the same number fetched from
  // multiple repos (e.g. fork + non-fork, both routed through the same
  // upstream) resolve to the clicked row's repo, not the first one scanned.
  const cachedDialogWorkItem = useAppStore((s) =>
    findTaskPageDialogWorkItem(s.workItemsCache, dialogWorkItemKey)
  )
  const dialogWorkItem = dialogWorkItemKey ? (cachedDialogWorkItem ?? dialogWorkItemFallback) : null

  const setDialogWorkItem = useCallback((item: GitHubWorkItem | null) => {
    setDialogWorkItemKey(item ? { id: item.id, repoId: item.repoId } : null)
    setDialogWorkItemFallback(item)
  }, [])

  // Why: feature 1 — render the "Issues from {owner}/{repo}" indicator per
  // selected repo whose issue-source and PR-source slugs differ, and surface
  // a per-repo retryable banner when the issue-side fetch failed. Both derive
  // from the same `workItemsCache` entry the list already consumes, so no
  // extra IPC round-trip is needed. The `TaskPageRepoSourceState` shape lives
  // with the cache selectors so the render and guard code share one contract.
  // Why: subscribe only to the cache entries this page can render. The selector
  // returns entry references so Zustand shallow equality filters unrelated
  // cache writes before they re-render the full tasks page.
  const perRepoSourceState = useMemo<TaskPageRepoSourceState[]>(
    () => buildTaskPageRepoSourceState(selectedRepos, selectedWorkItemsCacheEntries),
    [selectedRepos, selectedWorkItemsCacheEntries]
  )

  // Why: surface a one-time toast per session per repo when the user's
  // preferred `'upstream'` is no longer configured and we fell back to
  // origin. Gated on a ref-backed set so repeated list refreshes don't
  // re-toast. We deliberately do NOT auto-reset the preference — the user
  // may re-add `upstream` later and expect it to pick up again.
  const fellBackToastedRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (taskSource !== 'github') {
      return
    }
    for (const [index, r] of selectedRepos.entries()) {
      const entry = selectedWorkItemsCacheEntries[index]
      if (!entry?.issueSourceFellBack) {
        continue
      }
      if (fellBackToastedRef.current.has(r.id)) {
        continue
      }
      const prSlug = entry.sources?.prs
        ? `${entry.sources.prs.owner}/${entry.sources.prs.repo}`
        : r.displayName
      toast.message(
        `Your preferred issue source (upstream) is no longer configured for ${prSlug}. Using origin.`
      )
      fellBackToastedRef.current.add(r.id)
    }
  }, [selectedRepos, selectedWorkItemsCacheEntries, taskSource])

  // Why: on a partial-failure retry the cache still holds successful-side
  // data, so `tasksLoading` (which is gated on `anyUncached`) never flips
  // true and the Retry button would otherwise give no feedback. Track
  // retry-in-flight per repo (keyed by `repoPath`) so that clicking Retry
  // on one banner only flips that banner's button into its "Retrying…"
  // state — other still-failing banners stay in their "Retry" state rather
  // than misleadingly flipping in lockstep. The fetch effect clears the set
  // when the nonce-driven refresh settles.
  const [retryingRepoPaths, setRetryingRepoPaths] = useState<ReadonlySet<string>>(() => new Set())

  const handleRetryIssuesFetch = useCallback(
    (repoPath: string) => {
      const repo = selectedRepos.find((r) => r.path === repoPath)
      if (!repo) {
        return
      }
      // Why: bumping the shared refresh nonce reuses the Tasks list's
      // single fetch path — nonce changes are treated as force=true so
      // retry doesn't silently dedupe onto a still-failing in-flight request.
      // The nonce bump refreshes ALL selected repos, but the Retrying…
      // state is scoped to the clicked repo so other banners stay in their
      // "Retry" state rather than misleadingly flipping to "Retrying…".
      setRetryingRepoPaths((prev) => {
        const next = new Set(prev)
        next.add(repoPath)
        return next
      })
      setTaskRefreshNonce((n) => n + 1)
    },
    [selectedRepos]
  )
  const [newIssueOpen, setNewIssueOpen] = useState(false)
  const [newIssueTitle, setNewIssueTitle] = useState('')
  const [newIssueBody, setNewIssueBody] = useState('')
  const [newIssueSubmitting, setNewIssueSubmitting] = useState(false)
  const [newIssueRepoId, setNewIssueRepoId] = useState<string | null>(null)

  // Why: resolve the target repo from the user's choice, falling back to the
  // first selected repo if the chosen id drops out of the selection while the
  // dialog is open — keeps submit always landing on a valid repo.
  const newIssueTargetRepo = useMemo(
    () => selectedRepos.find((r) => r.id === newIssueRepoId) ?? selectedRepos[0] ?? null,
    [selectedRepos, newIssueRepoId]
  )

  const [drawerLinearIssueId, setDrawerLinearIssueId] = useState<string | null>(null)
  const [drawerLinearIssueFallback, setDrawerLinearIssueFallback] = useState<LinearIssue | null>(
    null
  )

  // Why: the Linear table keeps its own fetched array, while cell edits patch
  // the shared caches. The selector returns null while the drawer is closed, so
  // unrelated Linear cache writes don't re-render the whole Tasks page.
  const cachedDrawerLinearIssue = useAppStore((s) =>
    findTaskPageLinearDrawerIssue(s.linearIssueCache, s.linearSearchCache, drawerLinearIssueId)
  )
  const drawerLinearIssue = drawerLinearIssueId
    ? (cachedDrawerLinearIssue ?? drawerLinearIssueFallback)
    : null

  const setDrawerLinearIssue = useCallback((issue: LinearIssue | null) => {
    setDrawerLinearIssueId(issue?.id ?? null)
    setDrawerLinearIssueFallback(issue)
  }, [])

  // Linear tab state
  const [linearIssues, setLinearIssues] = useState<LinearIssue[]>([])
  const [linearLoading, setLinearLoading] = useState(false)
  const [linearError, setLinearError] = useState<string | null>(null)
  const [linearSearchInput, setLinearSearchInput] = useState('')
  const [appliedLinearSearch, setAppliedLinearSearch] = useState('')
  const [activeLinearPreset, setActiveLinearPreset] = useState<LinearPresetId>('all')
  const [linearRefreshNonce, setLinearRefreshNonce] = useState(0)

  useEffect(() => {
    if (taskResumeAppliedRef.current || !persistedUIReady || !settings) {
      return
    }

    setTaskSource(pageData.taskSource ?? settings.defaultTaskSource)
    setRepoSelection(resolvedInitialSelection)

    const nextGithubMode = taskResumeState?.githubMode ?? 'items'
    setGithubMode(nextGithubMode)

    const preset = taskResumeState?.githubItemsPreset
    if (preset === null) {
      const query = taskResumeState?.githubItemsQuery ?? ''
      setTaskSearchInput(query)
      setAppliedTaskSearch(query)
      setActiveTaskPreset(null)
    } else {
      const presetId = preset ?? settings.defaultTaskViewPreset
      const query = getTaskPresetQuery(presetId)
      setTaskSearchInput(query)
      setAppliedTaskSearch(query)
      setActiveTaskPreset(presetId)
    }

    const linearPreset = taskResumeState?.linearPreset ?? 'all'
    const linearQuery = taskResumeState?.linearQuery ?? ''
    setActiveLinearPreset(linearPreset)
    setLinearSearchInput(linearQuery)
    setAppliedLinearSearch(linearQuery)

    // Why: settings and persisted UI hydrate asynchronously. Apply the restored
    // Tasks context exactly once so later source/filter clicks remain local.
    taskResumeAppliedRef.current = true
    setTaskResumeApplied(true)
  }, [persistedUIReady, settings, pageData.taskSource, resolvedInitialSelection, taskResumeState])

  // Why: fetch the full team list from the Linear API so the selector shows
  // all teams the user belongs to, not just teams with issues in the current
  // fetch window. Fetched once when the Linear tab is active and connected.
  const [availableTeams, setAvailableTeams] = useState<LinearTeam[]>([])

  useEffect(() => {
    if (!taskResumeApplied) {
      return
    }
    if (taskSource !== 'linear' || !linearStatus.connected) {
      setAvailableTeams([])
      return
    }
    let cancelled = false
    // Why: workspace switches must not leave the prior workspace's teams
    // available for new-issue creation while the replacement fetch is pending.
    setAvailableTeams([])
    void linearListTeams(settings, selectedLinearWorkspaceId)
      .then((teams) => {
        if (!cancelled) {
          setAvailableTeams(teams)
        }
      })
      .catch(() => {
        if (!cancelled) {
          console.warn('[TaskPage] Failed to fetch Linear teams')
        }
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings, taskSource, linearStatus.connected, selectedLinearWorkspaceId, taskResumeApplied])

  // Why: stable key for `selectedRepos` so the GitLab fetch effect below
  // doesn't re-run on every parent re-render just because the array
  // reference changed. The memoized string keys off id + path +
  // connectionId — the only fields the effect actually reads.
  const selectedReposKey = useMemo(
    () => selectedRepos.map((r) => `${r.id}|${r.path}|${r.connectionId ?? ''}`).join(','),
    [selectedRepos]
  )

  // Why: GitLab task-source data fetch. Pulls MRs (filtered by state)
  // Why: fetch in parallel across every selected non-remote repo and
  // merge the results, mirroring the GitHub side's cross-repo
  // aggregation. Each repo's project is resolved from its git remote
  // by the main process — non-GitLab remotes return an error envelope
  // which we silently drop (filter chips on a GitHub-only repo
  // shouldn't surface "no GitLab project" banners).
  useEffect(() => {
    if (taskSource !== 'gitlab') {
      return
    }
    // Why: GitLab queries don't work over SSH-relay (yet) and folder-
    // mode repos have no remotes to derive a project from. Filter both.
    const eligibleRepos = selectedRepos.filter((r) => !r.connectionId)
    if (eligibleRepos.length === 0) {
      setGitlabItems([])
      setGitlabLoading(false)
      setGitlabError(null)
      return
    }
    let stale = false
    setGitlabLoading(true)
    setGitlabError(null)
    void Promise.allSettled(
      eligibleRepos.map((repo) =>
        window.api.gl
          .listWorkItems({
            repoPath: repo.path,
            state: gitlabFilter,
            page: 1,
            perPage: 50
          })
          .then((result) => ({
            repoId: repo.id,
            items: (result as { items: GitLabWorkItem[] }).items,
            // Why: not_found just means "this repo isn't a GitLab project"
            // (e.g. a GitHub-only repo in a mixed selection). Drop it
            // silently so the GitLab list doesn't show false errors.
            error:
              (result as { error?: { type?: string; message: string } }).error?.type === 'not_found'
                ? undefined
                : (result as { error?: { message: string } }).error
          }))
      )
    )
      .then((results) => {
        if (stale) {
          return
        }
        const merged: GitLabWorkItem[] = []
        const errs: string[] = []
        for (const r of results) {
          if (r.status !== 'fulfilled') {
            errs.push(r.reason instanceof Error ? r.reason.message : String(r.reason))
            continue
          }
          for (const item of r.value.items) {
            merged.push({ ...item, repoId: r.value.repoId })
          }
          if (r.value.error) {
            errs.push(r.value.error.message)
          }
        }
        merged.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
        setGitlabItems(merged)
        // Why: only surface an error banner when EVERY eligible repo
        // failed — partial failure (one of three GitLab projects has
        // a permission issue) is better signaled by the bare row count
        // than a banner that overshadows the working repos.
        if (errs.length > 0 && merged.length === 0) {
          setGitlabError(errs[0])
        }
      })
      .finally(() => {
        if (!stale) {
          setGitlabLoading(false)
        }
      })
    return () => {
      stale = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- selectedReposKey encodes the only selectedRepos fields read above; keying off the array ref would re-run on every parent render.
  }, [taskSource, gitlabFilter, gitlabRefreshNonce, selectedReposKey])

  // Why: Todos fetch lives in its own effect — different trigger
  // condition from the project view (no chip filter dependence) and a
  // different data path (`gl.todos` is user-scoped, not repo-scoped).
  useEffect(() => {
    if (taskSource !== 'gitlab' || gitlabView !== 'todos') {
      return
    }
    if (!primaryRepo?.path) {
      setGitlabTodos([])
      setGitlabTodosLoading(false)
      return
    }
    let stale = false
    setGitlabTodosLoading(true)
    void window.api.gl
      .todos({ repoPath: primaryRepo.path })
      .then((todos) => {
        if (!stale) {
          setGitlabTodos(todos as GitLabTodo[])
        }
      })
      .catch(() => {
        if (!stale) {
          setGitlabTodos([])
        }
      })
      .finally(() => {
        if (!stale) {
          setGitlabTodosLoading(false)
        }
      })
    return () => {
      stale = true
    }
  }, [taskSource, gitlabView, gitlabRefreshNonce, primaryRepo?.path])

  const defaultLinearTeamSelection = settings?.defaultLinearTeamSelection
  const [linearTeamSelection, setLinearTeamSelection] = useState<ReadonlySet<string>>(() => {
    if (!defaultLinearTeamSelection) {
      return new Set<string>()
    }
    return new Set(defaultLinearTeamSelection)
  })

  // Why: in sticky-all mode, auto-include all teams once the list arrives.
  // In explicit-selection mode, the set is already correct from the initializer.
  useEffect(() => {
    if (availableTeams.length === 0) {
      return
    }
    if (!defaultLinearTeamSelection) {
      setLinearTeamSelection(new Set(availableTeams.map((t) => t.id)))
    }
  }, [availableTeams, defaultLinearTeamSelection])

  const filteredLinearIssues = useMemo(
    () => linearIssues.filter((issue) => linearTeamSelection.has(issue.team.id)),
    [linearIssues, linearTeamSelection]
  )
  // New Linear issue dialog state
  const [newLinearIssueOpen, setNewLinearIssueOpen] = useState(false)
  const [newLinearIssueTitle, setNewLinearIssueTitle] = useState('')
  const [newLinearIssueBody, setNewLinearIssueBody] = useState('')
  const [newLinearIssueTeamId, setNewLinearIssueTeamId] = useState<string | null>(null)
  const [newLinearIssueSubmitting, setNewLinearIssueSubmitting] = useState(false)

  const newLinearIssueTargetTeam = useMemo(
    () => availableTeams.find((t) => t.id === newLinearIssueTeamId) ?? availableTeams[0] ?? null,
    [availableTeams, newLinearIssueTeamId]
  )

  const [linearConnectOpen, setLinearConnectOpen] = useState(false)
  const [linearApiKeyDraft, setLinearApiKeyDraft] = useState('')
  const [linearConnectState, setLinearConnectState] = useState<'idle' | 'connecting' | 'error'>(
    'idle'
  )
  const [linearConnectError, setLinearConnectError] = useState<string | null>(null)

  // Why: defense-in-depth safety net applied to the current page's items.
  // The server-side query now includes is:issue / is:pr qualifiers so this
  // filter is a no-op in the happy path. Kept as a guard against parser
  // regressions or stale cache contamination.
  const applyTypeFilter = useCallback(
    (items: GitHubWorkItem[]) => {
      if (!activeTaskPreset) {
        return items
      }
      return items.filter((item) => {
        if (activeTaskPreset === 'issues' || activeTaskPreset === 'my-issues') {
          return item.type === 'issue'
        }
        if (
          activeTaskPreset === 'prs' ||
          activeTaskPreset === 'my-prs' ||
          activeTaskPreset === 'review'
        ) {
          return item.type === 'pr'
        }
        return true
      })
    },
    [activeTaskPreset]
  )

  const currentPageItems = useMemo(() => pages[currentPage] ?? [], [pages, currentPage])

  const filteredWorkItems = useMemo(
    () => applyTypeFilter(currentPageItems),
    [applyTypeFilter, currentPageItems]
  )

  // Why: totalPages is derived from the search API count when available,
  // so the pagination bar shows the full range (with ellipsis) upfront.
  // Falls back to the loaded page count when the count hasn't returned yet.
  const totalPages =
    totalItemCount !== null
      ? Math.max(pages.length, Math.ceil(totalItemCount / CROSS_REPO_DISPLAY_LIMIT))
      : pages.length

  // Why: loads the next page using the oldest item's updatedAt as a cursor.
  // When targetPage is provided (from clicking a numbered page beyond loaded
  // pages), it chains fetches until that page is loaded.
  const handleLoadNextPage = useCallback(
    async (targetPage?: number) => {
      if (paginationLoading || selectedRepos.length === 0) {
        return
      }
      const lastPage = pages.at(-1)
      if (!lastPage || lastPage.length === 0) {
        return
      }
      const oldestItem = lastPage.at(-1)
      if (!oldestItem?.updatedAt) {
        return
      }
      const q = stripRepoQualifiers(appliedTaskSearch.trim())
      const repoArgs = selectedRepos.map((r) => ({ repoId: r.id, path: r.path }))

      const target = targetPage ?? pages.length
      setPaginationLoading(true)
      setLoadingTargetPage(target)
      try {
        let cursor = oldestItem.updatedAt
        let loadedPages = pages.length
        const newPages: GitHubWorkItem[][] = []

        while (loadedPages <= target) {
          const { items } = await fetchWorkItemsNextPage(
            repoArgs,
            PER_REPO_FETCH_LIMIT,
            CROSS_REPO_DISPLAY_LIMIT,
            q,
            cursor
          )
          if (items.length === 0) {
            break
          }
          newPages.push(items)
          cursor = items.at(-1)!.updatedAt
          loadedPages += 1
        }

        if (newPages.length > 0) {
          setPages((prev) => [...prev, ...newPages])
          setCurrentPage(target < loadedPages ? target : loadedPages - 1)
        }
      } catch (err) {
        console.error('Failed to load next page:', err)
      } finally {
        setPaginationLoading(false)
        setLoadingTargetPage(null)
      }
    },
    [paginationLoading, selectedRepos, pages, appliedTaskSearch, fetchWorkItemsNextPage]
  )

  useEffect(() => {
    if (!taskResumeApplied) {
      return
    }
    const timeout = window.setTimeout(() => {
      setAppliedTaskSearch(taskSearchInput)
    }, TASK_SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timeout)
  }, [taskSearchInput, taskResumeApplied])

  useEffect(() => {
    if (!taskResumeApplied) {
      return
    }
    if (!githubSearchPersistReadyRef.current) {
      githubSearchPersistReadyRef.current = true
      return
    }
    // Why: persist the debounced applied query regardless of the active
    // preset. The preset-click handler writes the canonical query for that
    // preset, so persisting again here is at worst idempotent. When the
    // user types into the search box `handleTaskSearchChange` clears the
    // preset, but persisting unconditionally also covers paths that change
    // appliedTaskSearch without going through that handler.
    setTaskResumeState({
      githubItemsPreset: activeTaskPreset,
      githubItemsQuery: appliedTaskSearch.trim()
    })
  }, [activeTaskPreset, appliedTaskSearch, setTaskResumeState, taskResumeApplied])

  useEffect(() => {
    if (!taskResumeApplied) {
      return
    }
    // Why: both early-return branches must clear `retryingRepoPaths` — if the
    // user clicks Retry and then switches `taskSource` away from 'github' (or
    // somehow ends up with zero repos selected) before the fetch dispatches,
    // neither the `.then` nor the `.catch` below will fire, and the Retry
    // button would stay stuck in its disabled/Retrying state indefinitely.
    if (taskSource !== 'github' || githubMode !== 'items') {
      setRetryingRepoPaths(new Set())
      return
    }
    if (selectedRepos.length === 0) {
      setRetryingRepoPaths(new Set())
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
      const cached = getCachedWorkItems(r.id, PER_REPO_FETCH_LIMIT, q)
      if (cached === null) {
        anyUncached = true
      } else {
        preMerged.push(...cached)
      }
    }
    // Why: always replace — if preMerged is empty (e.g. query just changed and
    // no repo has a cache entry for it), we clear the previous query's rows
    // rather than leaving them on screen under the spinner.
    const page0 =
      preMerged.length > 0
        ? [...preMerged]
            .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
            .slice(0, CROSS_REPO_DISPLAY_LIMIT)
        : []
    setPages([page0])
    setCurrentPage(0)
    setTotalItemCount(null)
    setTasksError(null)
    setFailedCount(0) // reset so a prior failure banner doesn't linger
    setTasksLoading(anyUncached)

    // Preserve the existing nonce-gated force behavior.
    const forceRefresh = taskRefreshNonce !== lastFetchedNonceRef.current
    lastFetchedNonceRef.current = taskRefreshNonce
    // Why: a preference flip bumps `workItemsInvalidationNonce`. Treat that
    // bump as a forced refresh so the fan-out bypasses the in-flight dedupe
    // map — otherwise an overlapping request started before the flip could
    // resolve the new fetch and repopulate the cache with pre-flip data.
    const preferenceInvalidated =
      workItemsInvalidationNonce !== lastFetchedInvalidationNonceRef.current
    lastFetchedInvalidationNonceRef.current = workItemsInvalidationNonce

    const repoArgs = selectedRepos.map((r) => ({ repoId: r.id, path: r.path }))
    // Why: snapshot the retrying paths at effect-dispatch so overlapping
    // retries don't clear each other's pending state. An earlier cancelled
    // effect settling after a newer retry starts would otherwise wipe the
    // newer retry's repo from the set. Clearing only the paths captured
    // when this effect dispatched preserves later additions.
    const dispatchedRetryPaths = retryingRepoPaths
    void fetchWorkItemsAcrossRepos(repoArgs, PER_REPO_FETCH_LIMIT, CROSS_REPO_DISPLAY_LIMIT, q, {
      force: (forceRefresh && taskRefreshNonce > 0) || preferenceInvalidated
    })
      .then(({ items, failedCount: failed }) => {
        // Why: clear only the repos this effect was responsible for
        // retrying (the snapshot captured at dispatch time). Overlapping
        // retries — a second click while a prior fetch is still in flight
        // — must not clear the newer repo from the set, so we can't just
        // reset the whole set here. The early-return branches above reset
        // the whole set because those branches won't dispatch a fetch.
        setRetryingRepoPaths((prev) => {
          if (dispatchedRetryPaths.size === 0) {
            return prev
          }
          const next = new Set(prev)
          for (const p of dispatchedRetryPaths) {
            next.delete(p)
          }
          return next
        })
        if (cancelled) {
          return
        }
        setPages([items])
        setCurrentPage(0)
        setFailedCount(failed)
        setTasksLoading(false)
      })
      .catch((err) => {
        // Why: fetchWorkItemsAcrossRepos swallows per-repo failures, so a
        // reject here means an IPC-level or programmer error — surface it.
        // Clear only the repos this effect was responsible for retrying
        // (the snapshot captured at dispatch time). Overlapping retries —
        // a second click while a prior fetch is still in flight — must
        // not clear the newer repo from the set, so we can't just reset
        // the whole set here. The early-return branches above reset the
        // whole set because those branches won't dispatch a fetch.
        setRetryingRepoPaths((prev) => {
          if (dispatchedRetryPaths.size === 0) {
            return prev
          }
          const next = new Set(prev)
          for (const p of dispatchedRetryPaths) {
            next.delete(p)
          }
          return next
        })
        if (cancelled) {
          return
        }
        setTasksError(err instanceof Error ? err.message : 'Failed to load GitHub work.')
        setFailedCount(0) // the per-repo banner would be misleading next to tasksError
        setTasksLoading(false)
      })

    // Why: fire-and-forget count query in parallel with the items fetch.
    // The search API is cached 120s server-side so this doesn't add
    // meaningful latency or rate-limit pressure.
    void countWorkItemsAcrossRepos(
      selectedRepos.map((r) => ({ repoId: r.id, path: r.path })),
      q
    ).then((count) => {
      if (!cancelled) {
        setTotalItemCount(count)
      }
    })

    return () => {
      cancelled = true
    }
    // Why: getCachedWorkItems and fetchWorkItemsAcrossRepos are stable zustand
    // selectors; depending on them would re-run the effect on unrelated store
    // updates. `workItemsInvalidationNonce` is explicitly included so a
    // preference flip (which only evicts cache) re-dispatches this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    selectedRepos,
    appliedTaskSearch,
    taskRefreshNonce,
    taskSource,
    githubMode,
    workItemsInvalidationNonce,
    taskResumeApplied
  ])

  const handleApplyTaskSearch = useCallback((): void => {
    const trimmed = taskSearchInput.trim()
    setTaskSearchInput(trimmed)
    setAppliedTaskSearch(trimmed)
    setActiveTaskPreset(null)
    setTaskResumeState({ githubItemsPreset: null, githubItemsQuery: trimmed })
    setTaskRefreshNonce((current) => current + 1)
  }, [setTaskResumeState, taskSearchInput])

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

  useEffect(() => {
    if (
      taskSource !== 'github' ||
      githubMode !== 'items' ||
      dialogWorkItem ||
      drawerLinearIssue ||
      newIssueOpen ||
      newLinearIssueOpen ||
      activeModal !== 'none'
    ) {
      return
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      const isMac = navigator.userAgent.includes('Mac')
      const modifierPressed = isMac ? event.metaKey : event.ctrlKey
      if (!modifierPressed || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'f') {
        return
      }

      const input = taskSearchInputRef.current
      if (!input) {
        return
      }
      const target = event.target
      if (
        target instanceof HTMLElement &&
        target !== input &&
        (target instanceof HTMLInputElement ||
          target instanceof HTMLTextAreaElement ||
          target.isContentEditable)
      ) {
        return
      }

      event.preventDefault()
      event.stopPropagation()
      input.focus()
      input.select()
    }

    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [
    activeModal,
    dialogWorkItem,
    drawerLinearIssue,
    githubMode,
    newIssueOpen,
    newLinearIssueOpen,
    taskSource
  ])

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
        initialRepoId: item.repoId,
        telemetrySource: 'sidebar'
      })
    },
    [openModal]
  )

  const handleUseWorkItem = useCallback(
    (item: GitHubWorkItem): void => {
      // Why: open the unified New Workspace dialog pre-filled with the work
      // item as the selected source so the user can confirm name / agent /
      // setup before the worktree is created. Earlier the "Use" CTA created
      // and activated the worktree synchronously, which was disorienting —
      // the worktree appeared in the sidebar before the user had a chance
      // to review it. The composer already owns the prefill flow. Telemetry
      // attribution flows via `openComposerForItem` (sets telemetrySource).
      openComposerForItem(item)
    },
    [openComposerForItem]
  )

  const handleCreateNewIssue = useCallback(async (): Promise<void> => {
    if (!newIssueTargetRepo) {
      return
    }
    const title = newIssueTitle.trim()
    if (!title || newIssueSubmitting) {
      return
    }
    setNewIssueSubmitting(true)
    try {
      const target = getRuntimeTargetForRepoId(newIssueTargetRepo.id)
      const result = target
        ? await callRuntimeRpc<Awaited<ReturnType<typeof window.api.gh.createIssue>>>(
            target,
            'github.createIssue',
            { repo: newIssueTargetRepo.id, title, body: newIssueBody },
            { timeoutMs: 30_000 }
          )
        : await window.api.gh.createIssue({
            repoPath: newIssueTargetRepo.path,
            repoId: newIssueTargetRepo.id,
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

      // Why: auto-open the new issue in the dialog so the user sees
      // exactly what was filed. Use an optimistic stub first so the dialog
      // has immediate content, then refine with the full `workItem` fetch.
      const stub: GitHubWorkItem = {
        id: `issue:${String(result.number)}`,
        repoId: newIssueTargetRepo.id,
        type: 'issue',
        number: result.number,
        title,
        state: 'open',
        url: result.url,
        labels: [],
        updatedAt: new Date().toISOString(),
        author: null
      }
      setDialogWorkItem(stub)
      const stubRepoId = newIssueTargetRepo.id
      const fullIssuePromise = target
        ? callRuntimeRpc<Awaited<ReturnType<typeof window.api.gh.workItem>>>(
            target,
            'github.workItem',
            { repo: newIssueTargetRepo.id, number: result.number, type: 'issue' },
            { timeoutMs: 30_000 }
          )
        : window.api.gh.workItem({
            repoPath: newIssueTargetRepo.path,
            repoId: newIssueTargetRepo.id,
            number: result.number,
            type: 'issue'
          })
      void fullIssuePromise
        .then((full) => {
          if (full) {
            // Why: `full` is `Omit<GitHubWorkItem, 'repoId'>` (IPC shape).
            // Cast through unknown: spreading a discriminated union loses the
            // discriminant, so `{ ...full, repoId }` doesn't typecheck as
            // GitHubWorkItem. The runtime shape is correct by construction.
            const withRepoId = { ...full, repoId: stubRepoId } as unknown as GitHubWorkItem
            setDialogWorkItem(withRepoId)
          }
        })
        .catch(() => {})
    } finally {
      setNewIssueSubmitting(false)
    }
  }, [newIssueBody, newIssueSubmitting, newIssueTargetRepo, newIssueTitle, setDialogWorkItem])

  const handleCreateNewLinearIssue = useCallback(async (): Promise<void> => {
    if (!newLinearIssueTargetTeam) {
      return
    }
    const title = newLinearIssueTitle.trim()
    if (!title || newLinearIssueSubmitting) {
      return
    }
    setNewLinearIssueSubmitting(true)
    try {
      const result = await linearCreateIssue(settings, {
        teamId: newLinearIssueTargetTeam.id,
        title,
        description: newLinearIssueBody || undefined,
        workspaceId: newLinearIssueTargetTeam.workspaceId
      })
      if (!result.ok) {
        toast.error(result.error || 'Failed to create issue.')
        return
      }
      toast.success(`Created ${result.identifier}`, {
        action: result.url
          ? {
              label: 'View',
              onClick: () => window.open(result.url, '_blank')
            }
          : undefined
      })
      setNewLinearIssueOpen(false)
      setNewLinearIssueTitle('')
      setNewLinearIssueBody('')
      setLinearRefreshNonce((n) => n + 1)

      // Why: auto-open the new issue in the side drawer so the user sees
      // exactly what was filed, mirroring the GitHub create-issue flow.
      void linearGetIssue(settings, result.id, newLinearIssueTargetTeam.workspaceId)
        .then((full) => {
          if (full) {
            setDrawerLinearIssue(full)
          }
        })
        .catch(() => {})
    } finally {
      setNewLinearIssueSubmitting(false)
    }
  }, [
    newLinearIssueBody,
    newLinearIssueSubmitting,
    newLinearIssueTargetTeam,
    newLinearIssueTitle,
    settings,
    setDrawerLinearIssue
  ])

  useEffect(() => {
    // Why: when a modal is open, let it own Esc dismissal.
    if (
      dialogWorkItem ||
      drawerLinearIssue ||
      newIssueOpen ||
      newLinearIssueOpen ||
      activeModal !== 'none'
    ) {
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
  }, [
    activeModal,
    closeTaskPage,
    dialogWorkItem,
    drawerLinearIssue,
    newIssueOpen,
    newLinearIssueOpen
  ])

  // Why: check Linear connection status on mount so the UI can show the
  // correct connected/disconnected state without requiring a settings visit.
  useEffect(() => {
    void checkLinearConnection()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Why: debounce the Linear search input so we don't fire a request on every
  // keystroke — matches the 300ms cadence used for GitHub search.
  useEffect(() => {
    if (!taskResumeApplied) {
      return
    }
    const timeout = window.setTimeout(() => {
      setAppliedLinearSearch(linearSearchInput)
    }, TASK_SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timeout)
  }, [linearSearchInput, taskResumeApplied])

  useEffect(() => {
    if (!taskResumeApplied) {
      return
    }
    if (!linearSearchPersistReadyRef.current) {
      linearSearchPersistReadyRef.current = true
      return
    }
    setTaskResumeState({ linearQuery: appliedLinearSearch.trim() })
  }, [appliedLinearSearch, setTaskResumeState, taskResumeApplied])

  // Why: fetch Linear issues when the tab is active and the account is
  // connected. An empty search falls back to `listLinearIssues` (assigned
  // issues) so the default view shows the user's own work.
  useEffect(() => {
    if (!taskResumeApplied) {
      return
    }
    if (taskSource !== 'linear') {
      return
    }
    if (!linearStatus.connected) {
      return
    }

    let cancelled = false
    setLinearLoading(true)
    setLinearError(null)

    const trimmed = appliedLinearSearch.trim()
    const request =
      trimmed.length > 0
        ? searchLinearIssues(trimmed, LINEAR_ITEM_LIMIT)
        : listLinearIssues(activeLinearPreset, LINEAR_ITEM_LIMIT)

    void request
      .then((issues) => {
        if (cancelled) {
          return
        }
        setLinearIssues(issues)
        setLinearLoading(false)
      })
      .catch((err) => {
        if (cancelled) {
          return
        }
        setLinearError(err instanceof Error ? err.message : 'Failed to load Linear issues.')
        setLinearLoading(false)
      })

    return () => {
      cancelled = true
    }
    // Why: searchLinearIssues and listLinearIssues are stable zustand selectors;
    // depending on them would re-run the effect on unrelated store updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    taskSource,
    linearStatus.connected,
    selectedLinearWorkspaceId,
    appliedLinearSearch,
    activeLinearPreset,
    linearRefreshNonce,
    taskResumeApplied
  ])

  // Why: for Linear issues the "Use" flow opens the composer with the issue
  // info adapted to the LinkedWorkItemSummary shape. Linear identifiers are
  // strings (e.g. "ENG-123") so we use 0 as a placeholder number since the
  // URL is the primary artifact the agent will act on.
  const openComposerForLinearItem = useCallback(
    (issue: LinearIssue): void => {
      const linkedWorkItem: LinkedWorkItemSummary = {
        type: 'issue',
        number: 0,
        title: issue.title,
        url: issue.url,
        linearIdentifier: issue.identifier
      }
      openModal('new-workspace-composer', {
        linkedWorkItem,
        prefilledName: getLinkedWorkItemSuggestedName(issue),
        telemetrySource: 'sidebar'
      })
    },
    [openModal]
  )

  const handleUseLinearItem = useCallback(
    (issue: LinearIssue): void => {
      // Why: same rationale as handleUseWorkItem — open the New Workspace
      // dialog pre-filled rather than yolo-creating the worktree, so the
      // user can confirm name / agent / setup before the worktree lands in
      // the sidebar. Telemetry attribution flows via openComposerForLinearItem.
      openComposerForLinearItem(issue)
    },
    [openComposerForLinearItem]
  )

  const handleLinearConnect = useCallback(async (): Promise<void> => {
    const key = linearApiKeyDraft.trim()
    if (!key) {
      return
    }
    setLinearConnectState('connecting')
    setLinearConnectError(null)
    try {
      const result = await connectLinear(key)
      if (result.ok) {
        setLinearApiKeyDraft('')
        setLinearConnectState('idle')
        setLinearConnectOpen(false)
      } else {
        setLinearConnectState('error')
        setLinearConnectError(result.error)
      }
    } catch (error) {
      setLinearConnectState('error')
      setLinearConnectError(error instanceof Error ? error.message : 'Connection failed')
    }
  }, [connectLinear, linearApiKeyDraft])

  return (
    <div className="relative flex h-full min-h-0 flex-1 overflow-hidden bg-background text-foreground">
      <div className="relative flex min-h-0 flex-1 flex-col">
        {/* Why: pt-1.5 vertically centers this row's 32px icon cluster (X +
            source toggles) with the sidebar's "Tasks" nav row. Sidebar Tasks
            center sits 22px below the titlebar (pt-2 + py-1.5 + half size-4
            icon). Matching that here needs 6px top padding above the 32px
            cluster (6 + 16 = 22). The previous pt-3 placed the cluster 6px
            too low, breaking the visual band across the top chrome. */}
        <div className="mx-auto flex w-full flex-1 flex-col min-h-0 px-5 pt-1.5 pb-5 md:px-8 md:pt-1.5 md:pb-7">
          <div className="flex-none flex flex-col gap-3">
            <section className="flex flex-col gap-3">
              <div className="flex flex-col gap-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    {/* Why: Close is anchored left in the same row as the
                        source icons so the top chrome is one compact band.
                        Left-aligned keeps it clear of the app sidebar on the
                        right edge. */}
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-7 rounded-full"
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
                    <div className="mx-1 h-5 w-px bg-border/50" aria-hidden />
                    {SOURCE_OPTIONS.map((source) => {
                      const active = taskSource === source.id
                      return (
                        <Tooltip key={source.id}>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              disabled={source.disabled}
                              onClick={() => {
                                setTaskSource(source.id)
                                void updateSettings({ defaultTaskSource: source.id }).catch(() => {
                                  toast.error('Failed to save default task source.')
                                })
                              }}
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
                  {taskSource === 'linear' && linearStatus.connected ? (
                    <div className="flex items-center gap-2">
                      {linearWorkspaces.length > 1 ? (
                        <Select
                          value={selectedLinearWorkspaceId ?? undefined}
                          onValueChange={(value) => {
                            void selectLinearWorkspace(value).catch(() => {
                              toast.error('Failed to switch Linear workspace.')
                            })
                          }}
                        >
                          <SelectTrigger className="h-8 w-[200px] rounded-md border-border/50 bg-muted/50 text-xs font-medium shadow-sm">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="all">All workspaces</SelectItem>
                            {linearWorkspaces.map((workspace) => (
                              <SelectItem key={workspace.id} value={workspace.id}>
                                {workspace.organizationName}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : null}
                      {availableTeams.length > 0 ? (
                        <div className="w-[200px]">
                          <TeamMultiCombobox
                            teams={availableTeams}
                            selected={linearTeamSelection}
                            onChange={(next) => {
                              setLinearTeamSelection(next)
                              void updateSettings({ defaultLinearTeamSelection: [...next] }).catch(
                                () => {
                                  toast.error('Failed to save team selection.')
                                }
                              )
                            }}
                            onSelectAll={() => {
                              setLinearTeamSelection(new Set(availableTeams.map((t) => t.id)))
                              void updateSettings({ defaultLinearTeamSelection: null }).catch(
                                () => {
                                  toast.error('Failed to save team selection.')
                                }
                              )
                            }}
                            triggerClassName="h-8 w-full rounded-md border border-border/50 bg-muted/50 px-2 text-xs font-medium shadow-sm transition hover:bg-muted/50 focus:ring-2 focus:ring-ring/20 focus:outline-none"
                          />
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>

                {taskSource === 'github' ? (
                  <div className="flex items-center gap-2">
                    {projectModeVisible ? (
                      <div className="flex items-center gap-1 text-xs">
                        {(['items', 'project'] as const).map((mode) => {
                          const active = githubMode === mode
                          return (
                            <button
                              key={mode}
                              type="button"
                              onClick={() => {
                                setGithubMode(mode)
                                setTaskResumeState({ githubMode: mode })
                              }}
                              className={cn(
                                'rounded-md border px-2 py-1 text-xs transition',
                                active
                                  ? 'border-border/50 bg-foreground/90 text-background'
                                  : 'border-border/50 bg-transparent text-foreground hover:bg-muted/50'
                              )}
                            >
                              {mode === 'items' ? 'Issues/PRs' : 'Project'}
                            </button>
                          )
                        })}
                      </div>
                    ) : null}
                    {/* Why: the repo combobox filters Items mode by repo. In
                        Project mode the row set comes from the project's
                        view filter (server-side), so this control would be
                        inert — hide it to avoid suggesting it does
                        something. */}
                    {githubMode !== 'project' && (
                      <div className="w-[200px]">
                        <RepoMultiCombobox
                          repos={eligibleRepos}
                          selected={repoSelection}
                          onChange={(next) => {
                            setRepoSelection(next)
                            void updateSettings({ defaultRepoSelection: [...next] }).catch(() => {
                              toast.error('Failed to save repo selection.')
                            })
                          }}
                          onSelectAll={() => {
                            const allIds = new Set(eligibleRepos.map((r) => r.id))
                            setRepoSelection(allIds)
                            void updateSettings({ defaultRepoSelection: null }).catch(() => {
                              toast.error('Failed to save repo selection.')
                            })
                          }}
                          triggerClassName="h-8 w-full rounded-md border border-border/50 bg-muted/50 px-2 text-xs font-medium shadow-sm transition hover:bg-muted/50 focus:ring-2 focus:ring-ring/20 focus:outline-none"
                        />
                      </div>
                    )}
                  </div>
                ) : null}

                {taskSource === 'github' && githubMode === 'items' ? (
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
                                setTaskResumeState({
                                  githubItemsPreset: option.id,
                                  githubItemsQuery: query
                                })
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
                        {/* Why: GitHub API budget pill is anchored next to the
                            Refresh button so the "maybe I shouldn't click
                            refresh again" decision is one glance away. Only
                            rendered in the GitHub section because Linear has
                            its own SDK-based quota and doesn't consume gh
                            budget. */}
                        <GitHubRateLimitPill />
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="outline"
                              size="icon"
                              onClick={() => {
                                setNewIssueTitle('')
                                setNewIssueBody('')
                                setNewIssueRepoId(primaryRepo?.id ?? null)
                                setNewIssueOpen(true)
                              }}
                              disabled={!newIssueTargetRepo}
                              aria-label="New GitHub issue"
                              className="border-border/50 bg-transparent hover:bg-muted/50 backdrop-blur-md supports-[backdrop-filter]:bg-transparent"
                            >
                              <Plus className="size-4" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent side="bottom" sideOffset={6}>
                            New GitHub issue
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
                          ref={taskSearchInputRef}
                          data-github-items-search-input
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
                              setTaskResumeState({ githubItemsPreset: null, githubItemsQuery: '' })
                              setTaskRefreshNonce((current) => current + 1)
                            }}
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground transition hover:text-foreground"
                          >
                            <X className="size-4" />
                          </button>
                        ) : null}
                      </div>
                    </div>

                    {(() => {
                      // Why: unify feature 1 (indicator) and feature 2 (selector)
                      // into a single chip per repo. Rendering both separately
                      // produced visually redundant output — two local-repo
                      // dot-labels, duplicate slugs. The selector's active pill
                      // + tooltip already announce the source, so the "Issues
                      // from {slug}" chip is only shown when the selector does
                      // not render (no upstream remote — nothing to toggle).
                      const rows = perRepoSourceState.filter(
                        (s) => hasUpstreamCandidateDivergence(s) || hasDivergentSources(s)
                      )
                      if (rows.length === 0) {
                        return null
                      }
                      return (
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          {rows.map((s) => {
                            const repo = selectedRepos.find((r) => r.id === s.repoId)
                            const showDotLabel = selectedRepos.length > 1 && repo
                            const selectorRenderable = hasUpstreamCandidateDivergence(s)
                            // Why: the static indicator has its own wrapping
                            // chip styles, so we render it standalone and don't
                            // nest it inside our own chip — nesting would
                            // double-border it.
                            if (!selectorRenderable && hasDivergentSources(s)) {
                              return (
                                <IssueSourceIndicator
                                  key={s.repoId}
                                  issues={s.sources.issues}
                                  prs={s.sources.prs}
                                  localRepo={
                                    showDotLabel && repo
                                      ? { displayName: repo.displayName, color: repo.badgeColor }
                                      : undefined
                                  }
                                />
                              )
                            }
                            if (!selectorRenderable || !repo) {
                              return null
                            }
                            // Why: must be a <div> (not <span>) because the child
                            // <IssueSourceSelector> renders a <div role="group">, and
                            // a block-level <div> nested inside an inline <span> is
                            // invalid HTML — React emits a hydration warning and
                            // browsers may auto-close the span. `issueSourceChipClass`
                            // uses `inline-flex`, so the visual rendering is identical.
                            return (
                              <div key={s.repoId} className={issueSourceChipClass}>
                                {showDotLabel ? (
                                  <RepoDotLabel
                                    name={repo.displayName}
                                    color={repo.badgeColor}
                                    dotClassName="size-1.5"
                                    className="text-[10px] text-muted-foreground"
                                  />
                                ) : null}
                                <IssueSourceSelector
                                  preference={repo.issueSourcePreference}
                                  origin={s.sources.prs}
                                  upstream={s.sources.upstreamCandidate}
                                  onChange={(next) => {
                                    void setIssueSourcePreference(repo.id, repo.path, next)
                                  }}
                                />
                              </div>
                            )
                          })}
                        </div>
                      )
                    })()}
                  </div>
                ) : taskSource === 'linear' && linearStatus.connected ? (
                  <div className="rounded-md rounded-b-none border border-border/50 bg-muted/50 p-3 shadow-sm">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="flex flex-wrap gap-2">
                        {LINEAR_PRESETS.map((preset) => {
                          const active = !linearSearchInput && activeLinearPreset === preset.id
                          return (
                            <button
                              key={preset.id}
                              type="button"
                              onClick={() => {
                                setLinearSearchInput('')
                                setAppliedLinearSearch('')
                                setActiveLinearPreset(preset.id)
                                setTaskResumeState({ linearPreset: preset.id, linearQuery: '' })
                                setLinearRefreshNonce((n) => n + 1)
                              }}
                              className={cn(
                                'rounded-md border px-2 py-1 text-xs transition',
                                active
                                  ? 'border-border/50 bg-foreground/90 text-background backdrop-blur-md'
                                  : 'border-border/50 bg-transparent text-foreground hover:bg-muted/50'
                              )}
                            >
                              {preset.label}
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
                                setNewLinearIssueTitle('')
                                setNewLinearIssueBody('')
                                setNewLinearIssueTeamId(availableTeams[0]?.id ?? null)
                                setNewLinearIssueOpen(true)
                              }}
                              disabled={availableTeams.length === 0}
                              aria-label="New Linear issue"
                              className="border-border/50 bg-transparent hover:bg-muted/50 backdrop-blur-md supports-[backdrop-filter]:bg-transparent"
                            >
                              <Plus className="size-4" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent side="bottom" sideOffset={6}>
                            New Linear issue
                          </TooltipContent>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="outline"
                              size="icon"
                              onClick={() => setLinearRefreshNonce((n) => n + 1)}
                              disabled={linearLoading}
                              aria-label="Refresh Linear issues"
                              className="border-border/50 bg-transparent hover:bg-muted/50 backdrop-blur-md supports-[backdrop-filter]:bg-transparent"
                            >
                              {linearLoading ? (
                                <LoaderCircle className="size-4 animate-spin" />
                              ) : (
                                <RefreshCw className="size-4" />
                              )}
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent side="bottom" sideOffset={6}>
                            Refresh Linear issues
                          </TooltipContent>
                        </Tooltip>
                      </div>
                    </div>
                    <div className="mt-3 flex items-center gap-3">
                      <div className="relative min-w-[320px] flex-1">
                        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                        <Input
                          value={linearSearchInput}
                          onChange={(e) => setLinearSearchInput(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              if (
                                shouldSuppressEnterSubmit(
                                  { isComposing: e.nativeEvent.isComposing, shiftKey: e.shiftKey },
                                  false
                                )
                              ) {
                                return
                              }
                              e.preventDefault()
                              const trimmed = linearSearchInput.trim()
                              setLinearSearchInput(trimmed)
                              setAppliedLinearSearch(trimmed)
                              setTaskResumeState({ linearQuery: trimmed })
                              setLinearRefreshNonce((n) => n + 1)
                            }
                          }}
                          placeholder="Search Linear issues..."
                          className="h-8 rounded-md border-border/50 bg-background pl-8 pr-8 text-xs"
                        />
                        {linearSearchInput ? (
                          <button
                            type="button"
                            aria-label="Clear search"
                            onClick={() => {
                              setLinearSearchInput('')
                              setAppliedLinearSearch('')
                              setTaskResumeState({ linearQuery: '' })
                              setLinearRefreshNonce((n) => n + 1)
                            }}
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground transition hover:text-foreground"
                          >
                            <X className="size-4" />
                          </button>
                        ) : null}
                      </div>
                    </div>
                  </div>
                ) : taskSource === 'gitlab' ? (
                  <div className="rounded-md rounded-b-none border border-border/50 bg-muted/50 p-3 shadow-sm">
                    {/* Why: view toggle — Project = the selected repo's MRs
                        and issues; My Todos = the user's cross-project
                        gitlab.com/dashboard/todos stream. They have
                        different data shapes so we render distinct lists
                        below. */}
                    <div className="mb-2 flex items-center gap-2">
                      {(['project', 'todos'] as const).map((view) => {
                        const active = gitlabView === view
                        const label = view === 'project' ? 'Project MRs' : 'My Todos'
                        return (
                          <button
                            key={view}
                            type="button"
                            onClick={() => setGitlabView(view)}
                            className={cn(
                              'rounded-md border px-2.5 py-1 text-xs transition',
                              active
                                ? 'border-foreground/40 bg-foreground/90 text-background'
                                : 'border-border/50 bg-transparent text-muted-foreground hover:bg-muted/50 hover:text-foreground'
                            )}
                          >
                            {label}
                          </button>
                        )
                      })}
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="flex flex-wrap gap-2">
                        {/* Why: state chips only apply to the project view
                            — todos are filtered to 'pending' state in the
                            backend and don't have an Open/Merged/Closed
                            axis. */}
                        {gitlabView === 'project'
                          ? GITLAB_TASK_FILTERS.map(({ id, label }) => {
                              const active = gitlabFilter === id
                              return (
                                <button
                                  key={id}
                                  type="button"
                                  onClick={() => {
                                    setGitlabFilter(id)
                                    setGitlabRefreshNonce((n) => n + 1)
                                  }}
                                  className={cn(
                                    'rounded-md border px-2 py-1 text-xs transition',
                                    active
                                      ? 'border-border/50 bg-foreground/90 text-background backdrop-blur-md'
                                      : 'border-border/50 bg-transparent text-foreground hover:bg-muted/50'
                                  )}
                                >
                                  {label}
                                </button>
                              )
                            })
                          : null}
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="outline"
                              size="icon"
                              onClick={() => setGitlabRefreshNonce((n) => n + 1)}
                              disabled={gitlabLoading || gitlabTodosLoading}
                              aria-label={
                                gitlabView === 'project'
                                  ? 'Refresh GitLab work items'
                                  : 'Refresh My Todos'
                              }
                              className="border-border/50 bg-transparent hover:bg-muted/50 backdrop-blur-md supports-[backdrop-filter]:bg-transparent"
                            >
                              {gitlabLoading || gitlabTodosLoading ? (
                                <LoaderCircle className="size-4 animate-spin" />
                              ) : (
                                <RefreshCw className="size-4" />
                              )}
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent side="bottom" sideOffset={6}>
                            {gitlabView === 'project'
                              ? 'Refresh GitLab work items'
                              : 'Refresh My Todos'}
                          </TooltipContent>
                        </Tooltip>
                      </div>
                    </div>
                  </div>
                ) : null}
              </div>
            </section>
          </div>

          {taskSource === 'github' && githubMode === 'project' ? (
            <div className="mt-3 flex min-h-0 max-h-full flex-col rounded-md border border-border/50 bg-muted/50 overflow-hidden shadow-sm">
              <ProjectViewWrapper />
            </div>
          ) : taskSource === 'github' ? (
            <div className="flex min-h-0 max-h-full flex-col rounded-md border border-t-0 border-border/50 bg-muted/50 overflow-hidden rounded-t-none shadow-sm">
              <div className="flex-none grid grid-cols-[80px_minmax(0,3fr)_minmax(110px,0.8fr)_100px_110px_112px] gap-3 border-b border-border/50 px-3 py-2 text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
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

                {perRepoSourceState
                  .filter((s) => s.error)
                  .map((s) => {
                    const err = s.error!
                    // Why: parent design doc §2 — when the issue fetch fails
                    // (e.g. a 403 on a private upstream) we render a retryable
                    // banner with slug-qualified copy instead of a silent
                    // empty list. The [Retry] action re-invokes the fetch
                    // with force=true via the shared refresh nonce so any
                    // still-failing in-flight request is invalidated first.
                    return (
                      <div
                        key={`source-err-${s.repoId}`}
                        role="alert"
                        // Why: aria-atomic ensures screen readers re-announce the full banner
                        // when retry produces a new error on the same repo. Without it, React's
                        // reconciliation (stable key per repo) may diff-only the changed text
                        // node and some assistive tech will miss the update.
                        aria-atomic="true"
                        className="flex items-center justify-between gap-3 border-b border-border/50 bg-destructive/10 px-4 py-3 text-sm text-destructive"
                      >
                        <span>
                          Couldn&apos;t load issues from{' '}
                          <span className="font-mono">
                            {err.source.owner}/{err.source.repo}
                          </span>{' '}
                          — {err.message}
                        </span>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleRetryIssuesFetch(s.repoPath)}
                          disabled={tasksLoading || retryingRepoPaths.has(s.repoPath)}
                        >
                          {retryingRepoPaths.has(s.repoPath) ? (
                            <span className="flex items-center gap-1">
                              <LoaderCircle className="h-3 w-3 animate-spin" />
                              Retrying…
                            </span>
                          ) : (
                            'Retry'
                          )}
                        </Button>
                      </div>
                    )
                  })}

                {tasksLoading && filteredWorkItems.length === 0 ? (
                  // Why: shimmer skeleton stands in for the first ~3 rows while
                  // the initial fetch is in flight, so the card is never empty
                  // or collapsed during load. Only shown when we have no cached
                  // items — on revalidate we keep the stale list visible.
                  <div className="divide-y divide-border/50">
                    {Array.from({ length: 3 }).map((_, i) => (
                      <div
                        key={i}
                        className="grid w-full gap-2 px-3 py-2 grid-cols-[80px_minmax(0,3fr)_minmax(110px,0.8fr)_100px_110px_112px]"
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

                {/* Why: suppress the generic empty state when any error banner is
                    visible (IPC reject via tasksError, cross-repo partial failure
                    via failedCount, or per-repo issue-side error). Showing
                    "No matching GitHub work" next to "Couldn't load issues from X/Y"
                    is contradictory and misleads the user into thinking they
                    typed the wrong query. */}
                {!tasksLoading &&
                filteredWorkItems.length === 0 &&
                !tasksError &&
                failedCount === 0 &&
                perRepoSourceState.every((s) => !s.error) ? (
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
                        // Why: combine repoId with item.id because two selected repos
                        // that route issues through the same upstream (e.g. fork +
                        // non-fork both resolving to stablyai/orca) surface the same
                        // item.id under different repoIds. React treats a bare id as
                        // a collision and warns + silently drops rows otherwise.
                        key={`${item.repoId}:${item.id}`}
                        role="button"
                        tabIndex={0}
                        onClick={() => setDialogWorkItem(item)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault()
                            setDialogWorkItem(item)
                          }
                        }}
                        className="grid w-full cursor-pointer gap-2 px-3 py-2 text-left transition hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 grid-cols-[80px_minmax(0,3fr)_minmax(110px,0.8fr)_100px_110px_112px]"
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
                          <GHStatusCell item={item} repo={itemRepo ?? null} />
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
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation()
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
                              <DropdownMenuItem onSelect={() => window.api.shell.openUrl(item.url)}>
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

                {/* Pagination controls — GitHub-style with ellipsis */}
                {filteredWorkItems.length > 0 && !tasksLoading && totalPages > 1 ? (
                  <PaginationBar
                    currentPage={currentPage}
                    totalPages={totalPages}
                    loadingTarget={loadingTargetPage}
                    onPageChange={(page) => {
                      if (page < pages.length) {
                        setCurrentPage(page)
                      } else {
                        void handleLoadNextPage(page)
                      }
                    }}
                  />
                ) : null}
              </div>
            </div>
          ) : taskSource === 'gitlab' && gitlabView === 'todos' ? (
            <div className="flex min-h-0 max-h-full flex-col rounded-md border border-t-0 border-border/50 bg-muted/50 overflow-hidden rounded-t-none shadow-sm">
              <div className="flex-none grid grid-cols-[110px_minmax(0,3fr)_minmax(120px,1.2fr)_110px_50px] gap-3 border-b border-border/50 px-3 py-2 text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
                <span>Action</span>
                <span>Title</span>
                <span>Project</span>
                <span>Updated</span>
                <span />
              </div>
              <div
                className="min-h-0 flex-initial overflow-y-auto scrollbar-sleek"
                style={{ scrollbarGutter: 'stable' }}
              >
                {gitlabTodosLoading && gitlabTodos.length === 0 ? (
                  <div className="divide-y divide-border/50">
                    {Array.from({ length: 3 }).map((_, i) => (
                      <div
                        key={i}
                        className="grid w-full gap-3 px-3 py-2 grid-cols-[110px_minmax(0,3fr)_minmax(120px,1.2fr)_110px_50px]"
                      >
                        <div className="h-4 w-20 animate-pulse rounded bg-muted/70" />
                        <div>
                          <div className="h-4 w-3/5 animate-pulse rounded bg-muted/70" />
                        </div>
                        <div className="h-3 w-24 animate-pulse rounded bg-muted/60" />
                        <div className="h-3 w-20 animate-pulse rounded bg-muted/60" />
                        <div />
                      </div>
                    ))}
                  </div>
                ) : null}
                {!gitlabTodosLoading && gitlabTodos.length === 0 ? (
                  <div className="px-4 py-12 text-center text-sm text-muted-foreground">
                    {primaryRepo
                      ? 'No pending todos. You’re all caught up!'
                      : 'Select a repo so we can authenticate to GitLab.'}
                  </div>
                ) : null}
                <div className="divide-y divide-border/50">
                  {gitlabTodos.map((todo) => (
                    <div
                      role="button"
                      tabIndex={0}
                      key={todo.id}
                      onClick={() => void window.api.shell.openUrl(todo.targetUrl)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          void window.api.shell.openUrl(todo.targetUrl)
                        }
                      }}
                      className="grid w-full cursor-pointer gap-3 px-3 py-2 text-left grid-cols-[110px_minmax(0,3fr)_minmax(120px,1.2fr)_110px_50px] hover:bg-muted/50"
                      title={
                        todo.targetType === 'MergeRequest'
                          ? `MR !${todo.targetIid ?? ''}`
                          : todo.targetType === 'Issue'
                            ? `Issue #${todo.targetIid ?? ''}`
                            : todo.targetType
                      }
                    >
                      <span className="text-xs text-muted-foreground">
                        {/* Why: GitLab action_name uses snake_case (assigned,
                            review_requested, build_failed). Replace _ with
                            space so the row reads like a sentence. */}
                        {todo.actionName.replace(/_/g, ' ')}
                      </span>
                      <span className="min-w-0 truncate text-sm">{todo.targetTitle}</span>
                      <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
                        {todo.projectPath}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {todo.updatedAt ? new Date(todo.updatedAt).toLocaleDateString() : ''}
                      </span>
                      <span className="flex justify-end">
                        <ExternalLink className="size-3.5 text-muted-foreground" />
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ) : taskSource === 'gitlab' ? (
            <div className="flex min-h-0 max-h-full flex-col rounded-md border border-t-0 border-border/50 bg-muted/50 overflow-hidden rounded-t-none shadow-sm">
              <div className="flex-none grid grid-cols-[80px_minmax(0,3fr)_120px_110px_50px] gap-3 border-b border-border/50 px-3 py-2 text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
                <span>ID</span>
                <span>Title</span>
                <span>Type / State</span>
                <span>Updated</span>
                <span />
              </div>
              <div
                className="min-h-0 flex-initial overflow-y-auto scrollbar-sleek"
                style={{ scrollbarGutter: 'stable' }}
              >
                {gitlabError ? (
                  <div className="border-b border-border px-4 py-4 text-sm text-destructive">
                    {gitlabError}
                  </div>
                ) : null}
                {gitlabLoading && gitlabItems.length === 0 ? (
                  // Why: matches the GitHub / Linear shimmer pattern so the card
                  // never flashes empty during the initial fetch.
                  <div className="divide-y divide-border/50">
                    {Array.from({ length: 3 }).map((_, i) => (
                      <div
                        key={i}
                        className="grid w-full gap-3 px-3 py-2 grid-cols-[80px_minmax(0,3fr)_120px_110px_50px]"
                      >
                        <div className="h-4 w-16 animate-pulse rounded bg-muted/70" />
                        <div>
                          <div className="h-4 w-3/5 animate-pulse rounded bg-muted/70" />
                        </div>
                        <div className="h-3 w-20 animate-pulse rounded bg-muted/60" />
                        <div className="h-3 w-20 animate-pulse rounded bg-muted/60" />
                        <div />
                      </div>
                    ))}
                  </div>
                ) : null}
                {!gitlabLoading && gitlabItems.length === 0 && !gitlabError ? (
                  <div className="px-4 py-12 text-center text-sm text-muted-foreground">
                    {primaryRepo
                      ? 'No GitLab work matches this filter.'
                      : 'Select a repo to see GitLab work items.'}
                  </div>
                ) : null}
                <div className="divide-y divide-border/50">
                  {gitlabItems.map((item) => (
                    // Why: row uses a <div role="button"> rather than a
                    // <button> because it nests an inner button for
                    // open-in-browser. Native <button> nesting is invalid
                    // HTML and React warns; the role + tabIndex + keyDown
                    // handler preserve a11y semantics.
                    <div
                      role="button"
                      tabIndex={0}
                      key={item.id}
                      onClick={() => setGitlabDialogItem(item)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          setGitlabDialogItem(item)
                        }
                      }}
                      className="grid w-full cursor-pointer gap-3 px-3 py-2 text-left grid-cols-[80px_minmax(0,3fr)_120px_110px_50px] hover:bg-muted/50"
                    >
                      <span className="font-mono text-xs text-muted-foreground">
                        {/* Why: GitLab's user-facing convention is `!N` for MRs
                            and `#N` for issues — matches gitlab.com's UI so users
                            scanning the list can map rows back to web links. */}
                        {item.type === 'mr' ? '!' : '#'}
                        {item.number}
                      </span>
                      <span className="min-w-0 truncate text-sm">{item.title}</span>
                      <span className="text-xs text-muted-foreground">
                        {item.type === 'mr' ? 'MR' : 'Issue'} · {item.state}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {item.updatedAt ? new Date(item.updatedAt).toLocaleDateString() : ''}
                      </span>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          void window.api.shell.openUrl(item.url)
                        }}
                        aria-label="Open in browser"
                        className="flex justify-end text-muted-foreground hover:text-foreground"
                      >
                        <ExternalLink className="size-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ) : !linearStatusChecked ? (
            <div className="mt-4 flex items-center justify-center py-14">
              <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : !linearStatus.connected ? (
            <div className="mt-4 flex flex-col items-center justify-center rounded-md border border-border/50 bg-muted/50 px-6 py-14 text-center shadow-sm">
              <LinearIcon className="mb-4 size-8 text-muted-foreground/60" />
              <p className="text-base font-medium text-foreground">Connect your Linear account</p>
              <p className="mt-2 max-w-sm text-sm text-muted-foreground">
                Browse and start work on your assigned Linear issues directly from here.
              </p>
              <Button
                className="mt-5"
                onClick={() => {
                  setLinearApiKeyDraft('')
                  setLinearConnectState('idle')
                  setLinearConnectError(null)
                  setLinearConnectOpen(true)
                }}
              >
                Connect Linear
              </Button>
            </div>
          ) : (
            /* Connected state: Linear issues table */
            <div className="flex min-h-0 max-h-full flex-col rounded-md border border-t-0 border-border/50 bg-muted/50 overflow-hidden rounded-t-none shadow-sm">
              <div className="flex-none grid grid-cols-[90px_minmax(0,3fr)_100px_120px_80px_90px_80px] gap-3 border-b border-border/50 px-3 py-2 text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
                <span>Identifier</span>
                <span>Title</span>
                <span>Team</span>
                <span>Status</span>
                <span>Priority</span>
                <span>Updated</span>
                <span />
              </div>

              <div
                className="min-h-0 flex-initial overflow-y-auto scrollbar-sleek"
                style={{ scrollbarGutter: 'stable' }}
              >
                {linearError ? (
                  <div className="border-b border-border px-4 py-4 text-sm text-destructive">
                    {linearError}
                  </div>
                ) : null}

                {linearLoading && linearIssues.length === 0 ? (
                  // Why: shimmer skeleton matches the GitHub tab pattern — 3 placeholder
                  // rows while the initial fetch is in flight so the card never flashes empty.
                  <div className="divide-y divide-border/50">
                    {Array.from({ length: 3 }).map((_, i) => (
                      <div
                        key={i}
                        className="grid w-full gap-2 px-3 py-2 grid-cols-[90px_minmax(0,3fr)_100px_120px_80px_90px_80px]"
                      >
                        <div className="flex items-center">
                          <div className="h-7 w-16 animate-pulse rounded-lg bg-muted/70" />
                        </div>
                        <div className="min-w-0">
                          <div className="h-4 w-3/5 animate-pulse rounded bg-muted/70" />
                          <div className="mt-2 h-3 w-2/5 animate-pulse rounded bg-muted/60" />
                        </div>
                        <div className="flex items-center">
                          <div className="h-3 w-16 animate-pulse rounded bg-muted/60" />
                        </div>
                        <div className="flex items-center">
                          <div className="h-5 w-16 animate-pulse rounded-full bg-muted/70" />
                        </div>
                        <div className="flex items-center">
                          <div className="h-3 w-12 animate-pulse rounded bg-muted/60" />
                        </div>
                        <div className="flex items-center">
                          <div className="h-3 w-16 animate-pulse rounded bg-muted/60" />
                        </div>
                        <div className="flex items-center justify-start lg:justify-end">
                          <div className="h-7 w-16 animate-pulse rounded-xl bg-muted/70" />
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}

                {!linearLoading && linearIssues.length === 0 && !linearError ? (
                  <div className="px-4 py-10 text-center">
                    <p className="text-base font-medium text-foreground">No Linear issues found</p>
                    <p className="mt-2 text-sm text-muted-foreground">
                      {linearSearchInput
                        ? 'Try a different search query.'
                        : 'No assigned issues. Try searching for something.'}
                    </p>
                  </div>
                ) : null}

                {!linearLoading && linearIssues.length > 0 && filteredLinearIssues.length === 0 ? (
                  <div className="px-4 py-10 text-center">
                    <p className="text-base font-medium text-foreground">
                      No issues match the selected teams
                    </p>
                    <p className="mt-2 text-sm text-muted-foreground">
                      Try selecting more teams or click &ldquo;All teams&rdquo;.
                    </p>
                  </div>
                ) : null}

                <div className="divide-y divide-border/50">
                  {filteredLinearIssues.map((issue) => (
                    <div
                      key={issue.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => setDrawerLinearIssue(issue)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          setDrawerLinearIssue(issue)
                        }
                      }}
                      className="cursor-pointer grid w-full gap-2 px-3 py-2 text-left transition hover:bg-muted/40 grid-cols-[90px_minmax(0,3fr)_100px_120px_80px_90px_80px]"
                    >
                      <div className="flex items-center">
                        <span className="inline-flex items-center gap-1 rounded-md border border-border/50 bg-muted/40 px-1.5 py-0.5 text-muted-foreground">
                          <span className="font-mono text-[11px] font-normal">
                            {issue.identifier}
                          </span>
                        </span>
                      </div>

                      <div className="min-w-0">
                        <h3 className="truncate text-[15px] font-semibold text-foreground">
                          {issue.title}
                        </h3>
                        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
                          {selectedLinearWorkspaceId === 'all' && issue.workspaceName ? (
                            <span>{issue.workspaceName}</span>
                          ) : null}
                          {issue.assignee ? <span>{issue.assignee.displayName}</span> : null}
                          {issue.labels.slice(0, 3).map((label) => (
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
                        <span className="truncate">{issue.team.name}</span>
                      </div>

                      <div className="flex items-center">
                        <LinearStatusCell issue={issue} />
                      </div>

                      <div className="flex items-center">
                        <LinearPriorityCell issue={issue} />
                      </div>

                      <Tooltip>
                        <TooltipTrigger asChild>
                          <div className="flex items-center text-[11px] text-muted-foreground">
                            {formatRelativeTime(issue.updatedAt)}
                          </div>
                        </TooltipTrigger>
                        <TooltipContent side="bottom" sideOffset={6}>
                          {new Date(issue.updatedAt).toLocaleString()}
                        </TooltipContent>
                      </Tooltip>

                      <div className="flex items-center justify-start gap-1 lg:justify-end">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation()
                            handleUseLinearItem(issue)
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
                            <DropdownMenuItem onSelect={() => window.api.shell.openUrl(issue.url)}>
                              <ExternalLink className="size-4" />
                              Open in browser
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
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
            {(() => {
              // Why: parent design doc §1 surface 2 — the composer is the
              // non-negotiable surface because User D's regression (filing a
              // personal TODO against upstream/fork after #1076 changed
              // routing) is specifically about this dialog. The description
              // line doubles as the source indicator: inlining the resolved
              // `{owner}/{repo}` slug (e.g. "stablyai/orca") means the
              // destination is impossible to miss before the user submits,
              // without needing a secondary chip that duplicates the info.
              // Falls back to the local displayName when the slug isn't
              // resolved yet (pre-IPC cache hit, or non-GitHub remote). The
              // multi-repo case uses the same computation — the Select below
              // drives `newIssueTargetRepo`, so the active target is known.
              const entry = newIssueTargetRepo
                ? perRepoSourceState.find((s) => s.repoId === newIssueTargetRepo.id)
                : undefined
              const issuesSlug = entry?.sources?.issues
                ? `${entry.sources.issues.owner}/${entry.sources.issues.repo}`
                : null
              const fallback = newIssueTargetRepo?.displayName ?? 'this repository'
              return <DialogDescription>Filing in {issuesSlug ?? fallback}</DialogDescription>
            })()}
            {(() => {
              // Why: mirror the Tasks-view selector in the composer so User D
              // (fork contributor filing a personal TODO against their own
              // fork) can flip the target *at the moment of filing* — the
              // only moment that matters for this regression. Reuses the
              // same cache entry the description line reads so no extra
              // IPC round-trip is needed.
              //
              // Why sibling of DialogDescription (not nested inside it):
              // DialogDescription renders a <p>, and `IssueSourceSelector`
              // renders a <div role="group"> with <button>s inside. Nesting
              // a div inside a <p> is invalid HTML — React emits a hydration
              // warning and some a11y tools flag it. Rendering the selector
              // as a sibling keeps both surfaces in the same header band
              // without the nesting violation.
              if (!newIssueTargetRepo) {
                return null
              }
              const entry = perRepoSourceState.find((s) => s.repoId === newIssueTargetRepo.id)
              if (!entry || !entry.sources?.upstreamCandidate || !entry.sources?.prs) {
                return null
              }
              if (sameGitHubOwnerRepo(entry.sources.prs, entry.sources.upstreamCandidate)) {
                return null
              }
              return (
                <div className="mt-1">
                  <IssueSourceSelector
                    preference={newIssueTargetRepo.issueSourcePreference}
                    origin={entry.sources.prs}
                    upstream={entry.sources.upstreamCandidate}
                    disabled={newIssueSubmitting}
                    // Why: the composer only files issues, so the "Issues from
                    // <slug>" tooltip restates what the surrounding form already
                    // implies. Keep it on the Tasks header (that page also lists
                    // PRs, which the selector doesn't affect).
                    suppressTooltip
                    onChange={(next) => {
                      void setIssueSourcePreference(
                        newIssueTargetRepo.id,
                        newIssueTargetRepo.path,
                        next
                      )
                    }}
                  />
                </div>
              )
            })()}
          </DialogHeader>
          <div className="flex flex-col gap-3">
            {selectedRepos.length > 1 ? (
              <div className="flex flex-col gap-1">
                <label className="text-[11px] font-medium text-muted-foreground">Repository</label>
                <Select
                  value={newIssueRepoId ?? undefined}
                  onValueChange={(v) => setNewIssueRepoId(v)}
                  disabled={newIssueSubmitting}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {selectedRepos.map((r) => (
                      <SelectItem key={r.id} value={r.id}>
                        <RepoDotLabel name={r.displayName} color={r.badgeColor} />
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}
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
              disabled={!newIssueTargetRepo || !newIssueTitle.trim() || newIssueSubmitting}
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

      <Dialog
        open={newLinearIssueOpen}
        onOpenChange={(open) => {
          if (!newLinearIssueSubmitting) {
            setNewLinearIssueOpen(open)
          }
        }}
      >
        <DialogContent
          className="sm:max-w-lg"
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault()
              void handleCreateNewLinearIssue()
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>New Linear issue</DialogTitle>
            <DialogDescription>
              {availableTeams.length > 1
                ? 'Creates a new issue in the selected team.'
                : `Creates a new issue in ${
                    newLinearIssueTargetTeam?.workspaceName
                      ? `${newLinearIssueTargetTeam.workspaceName} / `
                      : ''
                  }${newLinearIssueTargetTeam?.name ?? 'your team'}.`}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            {availableTeams.length > 1 ? (
              <div className="flex flex-col gap-1">
                <label className="text-[11px] font-medium text-muted-foreground">Team</label>
                <Select
                  value={newLinearIssueTeamId ?? undefined}
                  onValueChange={(v) => setNewLinearIssueTeamId(v)}
                  disabled={newLinearIssueSubmitting}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {availableTeams.map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        {selectedLinearWorkspaceId === 'all' && t.workspaceName
                          ? `${t.workspaceName} · `
                          : ''}
                        {t.key} — {t.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}
            <div className="flex flex-col gap-1">
              <label className="text-[11px] font-medium text-muted-foreground">Title</label>
              <Input
                autoFocus
                value={newLinearIssueTitle}
                onChange={(e) => setNewLinearIssueTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                    e.preventDefault()
                    void handleCreateNewLinearIssue()
                  }
                }}
                placeholder="Short summary"
                disabled={newLinearIssueSubmitting}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[11px] font-medium text-muted-foreground">
                Description (optional, markdown)
              </label>
              <textarea
                value={newLinearIssueBody}
                onChange={(e) => setNewLinearIssueBody(e.target.value)}
                placeholder="What's going on?"
                rows={6}
                disabled={newLinearIssueSubmitting}
                className="w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 resize-none max-h-60 overflow-y-auto"
              />
            </div>
            <p className="text-[10px] text-muted-foreground">Cmd/Ctrl+Enter to submit.</p>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setNewLinearIssueOpen(false)}
              disabled={newLinearIssueSubmitting}
            >
              Cancel
            </Button>
            <Button
              onClick={() => void handleCreateNewLinearIssue()}
              disabled={
                !newLinearIssueTargetTeam || !newLinearIssueTitle.trim() || newLinearIssueSubmitting
              }
            >
              {newLinearIssueSubmitting ? (
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

      <GitHubItemDialog
        workItem={dialogWorkItem}
        repoPath={
          // Why: the dialog is for a single item — resolve its repoPath from the
          // item's own repoId (set when fan-out merged the list) so it works in
          // cross-repo mode too. Reusing the memoized repo map avoids an O(n)
          // scan on every render while the dialog is open.
          dialogWorkItem ? (repoMap.get(dialogWorkItem.repoId)?.path ?? null) : null
        }
        repoId={dialogWorkItem?.repoId ?? null}
        onUse={(item) => {
          setDialogWorkItem(null)
          handleUseWorkItem(item)
        }}
        onClose={() => setDialogWorkItem(null)}
      />

      <LinearItemDrawer
        issue={drawerLinearIssue}
        onUse={(issue) => {
          setDrawerLinearIssue(null)
          handleUseLinearItem(issue)
        }}
        onClose={() => setDrawerLinearIssue(null)}
      />

      <GitLabItemDialog
        item={gitlabDialogItem}
        // Why: dialog's repoPath has to come from the clicked item's
        // own repo, not primaryRepo — items may originate in any of
        // the selected repos now that the GitLab fetch is multi-repo.
        repoPath={
          gitlabDialogItem
            ? (selectedRepos.find((r) => r.id === gitlabDialogItem.repoId)?.path ??
              primaryRepo?.path ??
              null)
            : null
        }
        onClose={() => setGitlabDialogItem(null)}
      />

      <Dialog
        open={linearConnectOpen}
        onOpenChange={(open) => {
          if (linearConnectState !== 'connecting') {
            setLinearConnectOpen(open)
          }
        }}
      >
        <DialogContent
          className="sm:max-w-md"
          onKeyDown={(e) => {
            if (
              e.key === 'Enter' &&
              linearApiKeyDraft.trim() &&
              linearConnectState !== 'connecting'
            ) {
              e.preventDefault()
              void handleLinearConnect()
            }
          }}
        >
          <DialogHeader className="gap-3">
            <DialogTitle className="leading-tight">Connect Linear workspace</DialogTitle>
            <DialogDescription>
              Paste a <strong className="font-semibold text-foreground">Personal API key</strong> to
              browse issues from that workspace.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <Input
              autoFocus
              type="password"
              placeholder="lin_api_..."
              value={linearApiKeyDraft}
              onChange={(e) => {
                setLinearApiKeyDraft(e.target.value)
                if (linearConnectState === 'error') {
                  setLinearConnectState('idle')
                  setLinearConnectError(null)
                }
              }}
              disabled={linearConnectState === 'connecting'}
            />
            {linearConnectState === 'error' && linearConnectError && (
              <p className="text-xs text-destructive">{linearConnectError}</p>
            )}
            <p className="text-xs text-muted-foreground">
              Create one in{' '}
              <button
                className="text-primary underline-offset-2 hover:underline"
                onClick={() =>
                  window.api.shell.openUrl('https://linear.app/settings/account/security')
                }
              >
                Linear Settings → Security
              </button>{' '}
              → <strong className="font-semibold text-foreground">New API key</strong> (not{' '}
              <span className="text-foreground">New passkey</span>).
            </p>
            <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground/70">
              <Lock className="size-3 shrink-0" />
              Your key is encrypted via the OS keychain and stored locally.
            </p>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setLinearConnectOpen(false)}
              disabled={linearConnectState === 'connecting'}
            >
              Cancel
            </Button>
            <Button
              onClick={() => void handleLinearConnect()}
              disabled={!linearApiKeyDraft.trim() || linearConnectState === 'connecting'}
            >
              {linearConnectState === 'connecting' ? (
                <>
                  <LoaderCircle className="size-4 animate-spin" />
                  Verifying…
                </>
              ) : (
                'Connect'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
