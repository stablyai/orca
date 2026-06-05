/* eslint-disable max-lines -- Why: the tasks page keeps the repo selector,
task source controls, and GitHub task list co-located so the wiring between the
selected repo, the task filters, and the work-item list stays readable in one
place while this surface is still evolving. */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  AlertCircle,
  ArrowDownUp,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleDot,
  Clock3,
  EllipsisVertical,
  ExternalLink,
  Eye,
  Files,
  Github,
  Gitlab,
  GitMerge,
  GitPullRequest,
  LayoutGrid,
  List,
  LoaderCircle,
  Lock,
  Minus,
  Plus,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Users,
  X,
  FolderKanban,
  Tag,
  UserRound
} from 'lucide-react'
import { toast } from 'sonner'

import { useAppStore } from '@/store'
import { useAllWorktrees, useRepoMap } from '@/store/selectors'
import { callRuntimeRpc, getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import { Button } from '@/components/ui/button'
import { ButtonGroup } from '@/components/ui/button-group'
import { Input } from '@/components/ui/input'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
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
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import RepoMultiCombobox from '@/components/ui/repo-multi-combobox'
import { LinearApiKeyDialog } from '@/components/linear-api-key-dialog'
import { LinearScopeSelector } from '@/components/linear-scope-selector'
import RepoBadgeLabel from '@/components/repo/RepoBadgeLabel'
import IssueSourceIndicator, { sameGitHubOwnerRepo } from '@/components/github/IssueSourceIndicator'
import IssueSourceSelector, { issueSourceChipClass } from '@/components/github/IssueSourceSelector'
import { LinearPriorityIcon } from '@/components/linear-priority-icon'
import { reconcileLinearTeamSelection } from '@/components/task-page-linear-team-selection'
import { useConfirmationDialog } from '@/components/confirmation-dialog'
import {
  getGitHubPRPrimaryReviewer,
  getGitHubPRReviewLabel,
  normalizeGitHubReviewerLogins,
  type GitHubPRPrimaryReviewer
} from '@/components/github-pr-reviewer-display'
import {
  getLinearStateMarkerStyle,
  getLinearStatePillStyle
} from '@/components/linear-state-pill-style'
import { parseTaskQuery, stripRepoQualifiers, withQualifier } from '../../../shared/task-query'
import {
  buildLinearTeamUrl,
  getLinearOrganizationUrlKeyFromIssueUrl
} from '../../../shared/linear-links'
import PRFilterDropdowns, { type PRFilterChange } from '@/components/github/PRFilterDropdowns'
import { GitHubMarkdownComposer } from '@/components/github/GitHubMarkdownComposer'
import { buildGitHubRepoUrl, parseGitHubIssueOrPRLink } from '@/lib/github-links'
import {
  findGithubWorkItemWorkspaceAttachment,
  getGithubWorkItemWorkspaceAttachmentLabel
} from '@/lib/github-work-item-workspace-attachment'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { useRepoAssigneesBySlug } from '@/hooks/useGitHubSlugMetadata'
import GitHubItemDialog, { type ItemDialogTab } from '@/components/GitHubItemDialog'
import PullRequestPage from '@/components/PullRequestPage'
import GitLabItemDialog from '@/components/GitLabItemDialog'
import ProjectViewWrapper from '@/components/github-project/ProjectViewWrapper'
import LinearIssueWorkspace from '@/components/LinearIssueWorkspace'
import {
  LinearCollectionNotice,
  LinearCustomViewTable,
  LinearProjectOverview,
  LinearProjectTable
} from '@/components/linear-project-view-surfaces'
import JiraIssueWorkspace from '@/components/JiraIssueWorkspace'
import { JiraIcon } from '@/components/icons/JiraIcon'
import { cn } from '@/lib/utils'
import {
  getLinkedWorkItemSuggestedName,
  getWorkspaceIntentName,
  getTaskPresetQuery,
  PER_REPO_FETCH_LIMIT,
  CROSS_REPO_DISPLAY_LIMIT
} from '@/lib/new-workspace'
import type { LinkedWorkItemSummary } from '@/lib/new-workspace'
import { buildLinearIssueLinkedWorkItem } from '@/lib/linear-linked-work-item'
import { isGitRepoKind } from '../../../shared/repo-kind'
import { getLinearIssueWorkspaceName } from '../../../shared/workspace-name'
import {
  buildTaskPageRepoSourceState,
  deriveTaskPageGitHubWorkItemsFetchOptions,
  findTaskPageDialogWorkItem,
  findTaskPageLinearIssue,
  reconcileTaskPageLinearIssuesAfterLandingRefresh,
  reconcileTaskPagePagesAfterLandingRefresh,
  reconcileTaskPagePagesWithWorkItemsCache,
  shouldResetTaskPagePaginationAfterLandingRefresh,
  selectTaskPageWorkItemsCacheEntries,
  shouldReplaceTaskPageItemsAfterRefresh,
  type TaskPageRepoSourceState
} from '@/components/task-page-cache-selectors'
import { findTaskPageJiraIssue } from '@/components/task-page-jira-cache-selectors'
import {
  createTaskPageGitHubStatusStateDraft,
  resolveTaskPageGitHubStatusStateDraft,
  updateTaskPageGitHubStatusLocalState
} from '@/components/task-page-github-status-state'
import { deriveTaskPagePRCheckSummary } from '@/components/task-page-pr-check-summary'
import { presentGitHubPRMergeState } from '@/components/github-pr-merge-state'
import {
  GITHUB_PR_MERGE_METHOD_LABELS,
  resolveGitHubPRMergeMethods
} from '../../../shared/github-pr-merge-methods'
import type {
  GitHubOwnerRepo,
  GitHubAssignableUser,
  GitHubPRMergeMethod,
  GitHubWorkItem,
  GitLabTodo,
  GitLabWorkItem,
  JiraCreateField,
  LinearCollectionResult,
  LinearCustomViewModel,
  LinearCustomViewSummary,
  JiraIssue,
  JiraIssueType,
  JiraProject,
  LinearIssue,
  LinearProjectDetail,
  LinearProjectSummary,
  LinearTeam,
  LinearWorkspaceSelection,
  LinearWorkflowState,
  Repo,
  TaskProvider,
  TaskViewPresetId
} from '../../../shared/types'
import {
  LINEAR_ISSUE_LIST_MAX,
  clampLinearIssueListLimit
} from '../../../shared/linear-issue-read-limits'
import { shouldSuppressEnterSubmit } from '@/lib/new-workspace-enter-guard'
import { useContextualTour } from '@/components/contextual-tours/use-contextual-tour'
import { getScreenSubmitShortcutLabel, isScreenSubmitShortcut } from '@/lib/screen-submit-shortcut'
import {
  useRepoAssignees,
  useRepoLabels,
  useTeamStates,
  useTeamMembers,
  useTeamLabels
} from '@/hooks/useIssueMetadata'
import {
  linearCreateIssue,
  linearGetIssue,
  linearTeamStates,
  linearUpdateIssue,
  linearListProjects
} from '@/runtime/runtime-linear-client'
import {
  jiraCreateIssue,
  jiraGetIssue,
  jiraListCreateFields,
  jiraListIssueTypes,
  jiraListProjects
} from '@/runtime/runtime-jira-client'
import {
  normalizeVisibleTaskProviders,
  restoreAvailableDefaultTaskProvider,
  resolveVisibleTaskProvider
} from '../../../shared/task-providers'

type TaskSource = TaskProvider

type GitLabTaskFilter = 'opened' | 'merged' | 'closed' | 'all'
type GitLabIssueFilter = 'opened' | 'assigned-to-me'

const GITLAB_MR_FILTERS: { id: GitLabTaskFilter; label: string }[] = [
  { id: 'opened', label: 'Open' },
  { id: 'merged', label: 'Merged' },
  { id: 'closed', label: 'Closed' },
  { id: 'all', label: 'All' }
]

const GITLAB_ISSUE_FILTERS: { id: GitLabIssueFilter; label: string }[] = [
  { id: 'opened', label: 'Open' },
  { id: 'assigned-to-me', label: 'Assigned to me' }
]

function isGitLabMRFilter(value: GitLabTaskFilter | GitLabIssueFilter): value is GitLabTaskFilter {
  return value === 'opened' || value === 'merged' || value === 'closed' || value === 'all'
}

function isGitLabIssueFilter(
  value: GitLabTaskFilter | GitLabIssueFilter
): value is GitLabIssueFilter {
  return value === 'opened' || value === 'assigned-to-me'
}
type TaskQueryPreset = {
  id: TaskViewPresetId
  label: string
  query: string
}
type GitHubTaskKind = 'issues' | 'prs'

const ISSUE_TASK_QUERY_PRESETS: TaskQueryPreset[] = [
  { id: 'issues', label: 'Open', query: getTaskPresetQuery('issues') },
  { id: 'my-issues', label: 'Assigned to me', query: getTaskPresetQuery('my-issues') }
]

const PR_TASK_QUERY_PRESETS: TaskQueryPreset[] = [
  { id: 'prs', label: 'Open', query: getTaskPresetQuery('prs') },
  { id: 'my-prs', label: 'Mine', query: getTaskPresetQuery('my-prs') },
  { id: 'review', label: 'Needs review', query: getTaskPresetQuery('review') }
]

function getGitHubTaskKindPresets(kind: GitHubTaskKind): TaskQueryPreset[] {
  return kind === 'prs' ? PR_TASK_QUERY_PRESETS : ISSUE_TASK_QUERY_PRESETS
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
  },
  {
    id: 'jira',
    label: 'Jira',
    Icon: ({ className }) => <JiraIcon className={className} />
  }
]

type JiraPresetId = 'assigned' | 'reported' | 'all' | 'done'
type JiraPreset = { id: JiraPresetId; label: string }

const JIRA_PRESETS: JiraPreset[] = [
  { id: 'assigned', label: 'Assigned' },
  { id: 'reported', label: 'Reported' },
  { id: 'all', label: 'All Open' },
  { id: 'done', label: 'Done' }
]

const TASK_SEARCH_DEBOUNCE_MS = 300
const LINEAR_ITEM_LIMIT = 36
const JIRA_ITEM_LIMIT = 50
const PR_CHECKS_EAGER_PREFETCH_LIMIT = 20

const GITHUB_TASK_GRID_CLASS =
  'min-w-[790px] grid-cols-[72px_minmax(320px,1fr)_84px_100px_92px_122px]'
const GITHUB_PR_TASK_GRID_CLASS =
  'min-w-[1020px] grid-cols-[72px_minmax(360px,2fr)_132px_128px_132px_92px_158px]'
const GITHUB_TASK_ROW_SURFACE_CLASS =
  '[background:color-mix(in_srgb,var(--muted)_50%,var(--background))]'
const GITHUB_TASK_ROW_HOVER_SURFACE_CLASS =
  'group-hover/github-task-row:[background:color-mix(in_srgb,var(--muted)_70%,var(--background))]'

function getGitHubWorkItemWorkspaceSeed(item: GitHubWorkItem): string {
  return (
    getWorkspaceIntentName({ workItem: item })?.seedName ?? getLinkedWorkItemSuggestedName(item)
  )
}

function getGitLabWorkItemWorkspaceSeed(item: GitLabWorkItem): string {
  return (
    getWorkspaceIntentName({
      workItem: {
        type: item.type,
        provider: 'gitlab',
        number: item.number,
        title: item.title
      }
    })?.seedName ?? getLinkedWorkItemSuggestedName(item)
  )
}

function getJiraIssueWorkspaceSeed(issue: JiraIssue): string {
  return (
    getWorkspaceIntentName({
      workItem: {
        type: 'issue',
        provider: 'jira',
        number: 0,
        title: `${issue.key} ${issue.title}`,
        jiraIdentifier: issue.key
      }
    })?.seedName ?? getLinkedWorkItemSuggestedName(issue)
  )
}

// Why: the row's px-3 left padding leaves a 12px gap between the scroll-viewport
// edge and the sticky ID column; without a covering ::before, scrolled cell text
// bleeds through that strip. Same trick as the title column for its 8px gap.
const GITHUB_TASK_STICKY_ID_HEADER_CLASS = cn(
  'sticky left-3 z-30 before:absolute before:-left-3 before:top-0 before:bottom-0 before:w-3 before:bg-inherit',
  GITHUB_TASK_ROW_SURFACE_CLASS
)
const GITHUB_TASK_STICKY_TITLE_HEADER_CLASS = cn(
  'sticky left-[92px] z-30 border-r border-border/50 before:absolute before:-left-2 before:top-0 before:bottom-0 before:w-2 before:bg-inherit',
  GITHUB_TASK_ROW_SURFACE_CLASS
)
const GITHUB_TASK_STICKY_ID_CELL_CLASS = cn(
  'sticky left-3 z-20 flex items-center before:absolute before:-left-3 before:top-0 before:bottom-0 before:w-3 before:bg-inherit',
  GITHUB_TASK_ROW_SURFACE_CLASS,
  GITHUB_TASK_ROW_HOVER_SURFACE_CLASS
)
const GITHUB_TASK_STICKY_TITLE_CELL_CLASS = cn(
  'sticky left-[92px] z-20 min-w-0 border-r border-border/50 pr-2 before:absolute before:-left-2 before:top-0 before:bottom-0 before:w-2 before:bg-inherit',
  GITHUB_TASK_ROW_SURFACE_CLASS,
  GITHUB_TASK_ROW_HOVER_SURFACE_CLASS
)

type GitHubModeButton = { id: GitHubTaskKind | 'project'; label: string }

const GITHUB_MODE_BUTTONS: GitHubModeButton[] = [
  { id: 'issues', label: 'Issues' },
  { id: 'prs', label: 'PRs' },
  { id: 'project', label: 'Projects' }
]

function isPRFocusedTaskView(preset: TaskViewPresetId | null, query: string): boolean {
  if (preset === 'prs' || preset === 'my-prs' || preset === 'review') {
    return true
  }
  const parsed = parseTaskQuery(query)
  return (
    parsed.scope === 'pr' ||
    parsed.state === 'merged' ||
    parsed.draft ||
    parsed.reviewRequested !== null ||
    parsed.reviewedBy !== null
  )
}

function normalizeGitHubTaskPreset(preset: TaskViewPresetId | null | undefined): TaskViewPresetId {
  // Why: the split Issues/PRs tabs no longer have a mixed "All" view, so
  // legacy saved defaults should land on the first tab instead of mixing rows.
  return !preset || preset === 'all' ? 'issues' : preset
}

function getGitHubTaskKind(preset: TaskViewPresetId | null, query: string): GitHubTaskKind {
  return isPRFocusedTaskView(preset, query) ? 'prs' : 'issues'
}

function getDefaultPresetForGitHubTaskKind(kind: GitHubTaskKind): TaskViewPresetId {
  return kind === 'prs' ? 'prs' : 'issues'
}

function scopeGitHubTaskSearch(query: string, kind: GitHubTaskKind): string {
  const trimmed = query.trim()
  if (!trimmed) {
    return getTaskPresetQuery(getDefaultPresetForGitHubTaskKind(kind))
  }
  if (/\bis:(?:issue|pr|pull-request)\b/i.test(trimmed)) {
    return trimmed
  }
  const parsed = parseTaskQuery(trimmed)
  const inferredKind = parsed.scope === 'pr' ? 'prs' : parsed.scope === 'issue' ? 'issues' : kind
  return `${inferredKind === 'prs' ? 'is:pr' : 'is:issue'} ${trimmed}`
}

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

// Why: Linear encodes priority as an integer (0–4). Map to human-readable
// labels so the table column is scannable without memorising the scale.
const LINEAR_PRIORITY_LABELS: Record<number, string> = {
  0: 'None',
  1: 'Urgent',
  2: 'High',
  3: 'Medium',
  4: 'Low'
}

type LinearViewMode = 'list' | 'board'
type LinearMode = 'issues' | 'projects' | 'views'
type LinearProjectTab = 'overview' | 'issues'
type LinearGroupBy = 'none' | 'status' | 'assignee' | 'priority' | 'team'
type LinearOrderBy = 'priority' | 'updated' | 'identifier'
type LinearDisplayProperty = 'state' | 'priority' | 'assignee' | 'team' | 'labels' | 'updated'

type LinearGroupSection = {
  key: string
  label: string
  issues: LinearIssue[]
}

type LinearIssueListRow =
  | { type: 'section'; key: string; label: string; count: number }
  | { type: 'issue'; issue: LinearIssue }

const LINEAR_BOARD_DRAG_ISSUE_MIME = 'application/x-orca-linear-issue-id'

const LINEAR_MODE_OPTIONS: { id: LinearMode; label: string }[] = [
  { id: 'issues', label: 'Issues' },
  { id: 'projects', label: 'Projects' },
  { id: 'views', label: 'Views' }
]

const LINEAR_CUSTOM_VIEW_MODEL_OPTIONS: { id: LinearCustomViewModel; label: string }[] = [
  { id: 'issue', label: 'Issues' },
  { id: 'project', label: 'Projects' }
]

const LINEAR_VIEW_OPTIONS: {
  id: LinearViewMode
  label: string
  Icon: typeof List
}[] = [
  { id: 'list', label: 'List', Icon: List },
  { id: 'board', label: 'Board', Icon: LayoutGrid }
]

const LINEAR_GROUP_OPTIONS: { id: LinearGroupBy; label: string }[] = [
  { id: 'none', label: 'No grouping' },
  { id: 'status', label: 'Status' },
  { id: 'assignee', label: 'Assignee' },
  { id: 'priority', label: 'Priority' },
  { id: 'team', label: 'Team' }
]

const LINEAR_ORDER_OPTIONS: { id: LinearOrderBy; label: string }[] = [
  { id: 'priority', label: 'Priority' },
  { id: 'updated', label: 'Updated' },
  { id: 'identifier', label: 'Identifier' }
]

const LINEAR_DISPLAY_PROPERTIES: { id: LinearDisplayProperty; label: string }[] = [
  { id: 'state', label: 'Status' },
  { id: 'priority', label: 'Priority' },
  { id: 'assignee', label: 'Assignee' },
  { id: 'team', label: 'Team' },
  { id: 'labels', label: 'Labels' },
  { id: 'updated', label: 'Updated' }
]

const DEFAULT_LINEAR_DISPLAY_PROPERTIES: LinearDisplayProperty[] = [
  'state',
  'priority',
  'assignee',
  'team',
  'labels',
  'updated'
]

function getLinearPriorityLabel(priority: number): string {
  return LINEAR_PRIORITY_LABELS[priority] ?? `P${priority}`
}

function getLinearStatusSectionState(section: LinearGroupSection): LinearIssue['state'] | null {
  if (!section.key.startsWith('status:')) {
    return null
  }
  return section.issues[0]?.state ?? null
}

function findLinearWorkflowStateForStatus(
  states: LinearWorkflowState[],
  targetState: LinearIssue['state']
): LinearWorkflowState | undefined {
  return (
    states.find((state) => state.name === targetState.name && state.type === targetState.type) ??
    states.find((state) => state.name === targetState.name)
  )
}

function LinearStateCell({
  issue,
  className
}: {
  issue: LinearIssue
  className?: string
}): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const patchLinearIssue = useAppStore((s) => s.patchLinearIssue)
  const states = useTeamStates(issue.team.id, settings, issue.workspaceId)
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const reqRef = useRef(0)

  const currentStateId = states.data.find(
    (s) => s.name === issue.state.name && s.type === issue.state.type
  )?.id

  const handleStateChange = useCallback(
    (stateId: string) => {
      const newState = states.data.find((s) => s.id === stateId)
      if (!newState || stateId === currentStateId || pending) {
        return
      }

      reqRef.current += 1
      const reqId = reqRef.current
      const previousState = issue.state
      const nextState: LinearIssue['state'] = {
        name: newState.name,
        type: newState.type,
        color: newState.color
      }

      setPending(true)
      patchLinearIssue(issue.id, { state: nextState })
      void linearUpdateIssue(settings, issue.id, { stateId }, issue.workspaceId)
        .then((result) => {
          if (reqId !== reqRef.current) {
            return
          }
          if (result.ok === false) {
            patchLinearIssue(issue.id, { state: previousState })
            toast.error(result.error ?? 'Failed to update Linear state')
          }
        })
        .catch(() => {
          if (reqId !== reqRef.current) {
            return
          }
          patchLinearIssue(issue.id, { state: previousState })
          toast.error('Failed to update Linear state')
        })
        .finally(() => {
          if (reqId === reqRef.current) {
            setPending(false)
          }
        })
    },
    [
      currentStateId,
      issue.id,
      issue.state,
      issue.workspaceId,
      patchLinearIssue,
      pending,
      settings,
      states.data
    ]
  )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={pending}
          onClick={(e) => e.stopPropagation()}
          className={cn(
            'inline-flex min-w-0 cursor-pointer! items-center gap-1 rounded-full border text-[11px] font-medium transition-[background-color,border-color,color,box-shadow] hover:[--linear-state-pill-current-background:var(--linear-state-pill-hover-background)] hover:[--linear-state-pill-current-border:var(--linear-state-pill-hover-border)] hover:[--linear-state-pill-current-foreground:var(--linear-state-pill-hover-foreground)] hover:ring-1 hover:ring-foreground/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-default! disabled:opacity-80 [&_*]:cursor-pointer! disabled:[&_*]:cursor-default!',
            className
          )}
          style={{
            ...getLinearStatePillStyle(issue.state.color),
            cursor: pending ? 'default' : 'pointer'
          }}
          aria-label={`Change Linear state from ${issue.state.name}`}
          aria-busy={pending || states.loading}
        >
          <span
            className="size-1.5 shrink-0 rounded-full"
            style={getLinearStateMarkerStyle(issue.state.color)}
          />
          <span className="truncate">{issue.state.name}</span>
          {pending || states.loading ? (
            <LoaderCircle className="size-3 shrink-0 animate-spin opacity-70" />
          ) : (
            <ChevronDown className="size-3 shrink-0 opacity-55" />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="popover-scroll-content scrollbar-sleek w-48 p-1"
        align="start"
        onClick={(e) => e.stopPropagation()}
      >
        {states.error ? (
          <div className="px-2 py-3 text-center text-[12px] text-destructive">{states.error}</div>
        ) : states.loading ? (
          <div className="flex items-center gap-2 px-2 py-3 text-[12px] text-muted-foreground">
            <LoaderCircle className="size-3 animate-spin" />
            Loading states
          </div>
        ) : states.data.length > 0 ? (
          states.data.map((state) => (
            <button
              key={state.id}
              type="button"
              onClick={() => {
                handleStateChange(state.id)
                setOpen(false)
              }}
              className={cn(
                'flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[12px] hover:bg-accent',
                currentStateId === state.id && 'bg-accent/50'
              )}
            >
              <span
                className="inline-block size-2 rounded-full"
                style={{ backgroundColor: state.color }}
              />
              {state.name}
            </button>
          ))
        ) : (
          <div className="px-2 py-3 text-center text-[12px] text-muted-foreground">
            No states found
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

function getLinearPriorityRank(priority: number): number {
  return priority === 0 ? 5 : priority
}

function compareLinearIssues(a: LinearIssue, b: LinearIssue, orderBy: LinearOrderBy): number {
  if (orderBy === 'updated') {
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  }
  if (orderBy === 'identifier') {
    return a.identifier.localeCompare(b.identifier, undefined, { numeric: true })
  }

  const priorityDelta = getLinearPriorityRank(a.priority) - getLinearPriorityRank(b.priority)
  if (priorityDelta !== 0) {
    return priorityDelta
  }
  return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
}

function getLinearIssueGroup(
  issue: LinearIssue,
  groupBy: LinearGroupBy
): { key: string; label: string } {
  if (groupBy === 'status') {
    return { key: `status:${issue.state.name}`, label: issue.state.name }
  }
  if (groupBy === 'assignee') {
    return {
      key: `assignee:${issue.assignee?.id ?? 'unassigned'}`,
      label: issue.assignee?.displayName ?? 'Unassigned'
    }
  }
  if (groupBy === 'priority') {
    return {
      key: `priority:${issue.priority}`,
      label: getLinearPriorityLabel(issue.priority)
    }
  }
  if (groupBy === 'team') {
    return { key: `team:${issue.team.id}`, label: issue.team.name }
  }
  return { key: 'all', label: 'Issues' }
}

function groupLinearIssues(
  issues: LinearIssue[],
  groupBy: LinearGroupBy,
  orderBy: LinearOrderBy
): LinearGroupSection[] {
  const sorted = [...issues].sort((a, b) => compareLinearIssues(a, b, orderBy))
  if (groupBy === 'none') {
    return [{ key: 'all', label: 'Issues', issues: sorted }]
  }

  const sections = new Map<string, LinearGroupSection>()
  for (const issue of sorted) {
    const group = getLinearIssueGroup(issue, groupBy)
    const section = sections.get(group.key)
    if (section) {
      section.issues.push(issue)
    } else {
      sections.set(group.key, { key: group.key, label: group.label, issues: [issue] })
    }
  }
  return [...sections.values()]
}

function getLinearIssueGridTemplate(visibleProperties: ReadonlySet<LinearDisplayProperty>): string {
  const columns = ['96px', 'minmax(240px,1.55fr)']
  if (visibleProperties.has('labels')) {
    columns.push('minmax(168px,0.9fr)')
  }
  if (visibleProperties.has('team')) {
    columns.push('minmax(172px,0.9fr)')
  }
  if (visibleProperties.has('state')) {
    columns.push('138px')
  }
  if (visibleProperties.has('assignee')) {
    columns.push('64px')
  }
  if (visibleProperties.has('updated')) {
    columns.push('104px')
  }
  columns.push('64px')
  return columns.join(' ')
}

function getJiraStatusTone(categoryKey: string): string {
  if (categoryKey === 'done') {
    return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-200'
  }
  if (categoryKey === 'indeterminate') {
    return 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-200'
  }
  return 'border-border/50 bg-muted/40 text-muted-foreground'
}

function getJiraProjectSelectionKey(project: JiraProject): string {
  return `${project.siteId ?? 'selected'}:${project.id}`
}

const jiraProjectLabelCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base'
})

function getJiraProjectDisplayLabel(project: JiraProject, includeSiteName: boolean): string {
  const projectLabel = `${project.name} (${project.key})`
  if (includeSiteName && project.siteName) {
    return `${project.siteName} · ${projectLabel}`
  }
  return projectLabel
}

function compareJiraProjectsByDisplayLabel(
  a: JiraProject,
  b: JiraProject,
  includeSiteName: boolean
): number {
  const siteComparison = includeSiteName
    ? jiraProjectLabelCollator.compare(a.siteName ?? '', b.siteName ?? '')
    : 0
  if (siteComparison !== 0) {
    return siteComparison
  }
  const nameComparison = jiraProjectLabelCollator.compare(a.name, b.name)
  if (nameComparison !== 0) {
    return nameComparison
  }
  return jiraProjectLabelCollator.compare(a.key, b.key)
}

function getJiraProjectSearchText(project: JiraProject, includeSiteName: boolean): string {
  return [
    getJiraProjectDisplayLabel(project, includeSiteName),
    project.key,
    project.name,
    project.siteName ?? ''
  ]
    .join(' ')
    .toLocaleLowerCase()
}

const JIRA_CREATE_SYSTEM_FIELD_KEYS = new Set(['project', 'issuetype', 'summary', 'description'])

function isVisibleJiraCreateField(field: JiraCreateField): boolean {
  return field.required && !JIRA_CREATE_SYSTEM_FIELD_KEYS.has(field.key)
}

function getJiraCreateAllowedValueLabel(
  value: NonNullable<JiraCreateField['allowedValues']>[number]
): string {
  return value.name ?? value.value ?? value.id ?? 'Option'
}

function findJiraCreateAllowedValue(field: JiraCreateField, draftValue: string) {
  return field.allowedValues?.find((value) => {
    return value.id === draftValue || value.value === draftValue || value.name === draftValue
  })
}

function jiraCreateTextToAdf(text: string): Record<string, unknown> {
  return {
    type: 'doc',
    version: 1,
    content: text.split(/\r?\n/).map((line) => ({
      type: 'paragraph',
      content: line ? [{ type: 'text', text: line }] : []
    }))
  }
}

function getJiraCreateOptionPayload(
  value: NonNullable<JiraCreateField['allowedValues']>[number] | undefined,
  fallback: string
): Record<string, string> | string {
  if (value?.id) {
    return { id: value.id }
  }
  if (value?.value) {
    return { value: value.value }
  }
  if (value?.name) {
    return { name: value.name }
  }
  return fallback
}

function buildJiraCreateFieldValue(field: JiraCreateField, draftValue: string): unknown {
  const trimmed = draftValue.trim()
  if (!trimmed) {
    return undefined
  }
  if (field.schema?.type === 'array') {
    const parts = trimmed
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
    if (field.allowedValues?.length) {
      return parts.map((part) =>
        getJiraCreateOptionPayload(findJiraCreateAllowedValue(field, part), part)
      )
    }
    return parts
  }
  if (field.allowedValues?.length) {
    return getJiraCreateOptionPayload(findJiraCreateAllowedValue(field, trimmed), trimmed)
  }
  if (field.schema?.type === 'number') {
    const numberValue = Number(trimmed)
    return Number.isFinite(numberValue) ? numberValue : trimmed
  }
  if (field.schema?.custom?.includes(':textarea') || field.schema?.type === 'textarea') {
    return jiraCreateTextToAdf(trimmed)
  }
  return trimmed
}

function buildJiraCreateCustomFields(
  fields: readonly JiraCreateField[],
  values: Record<string, string>
): Record<string, unknown> | undefined {
  const customFields: Record<string, unknown> = {}
  for (const field of fields) {
    const value = buildJiraCreateFieldValue(field, values[field.key] ?? '')
    if (value !== undefined) {
      customFields[field.key] = value
    }
  }
  return Object.keys(customFields).length > 0 ? customFields : undefined
}

function GHStatusCell({
  item,
  repo
}: {
  item: GitHubWorkItem
  repo: Repo | null
}): React.JSX.Element {
  const patchWorkItem = useAppStore((s) => s.patchWorkItem)
  const [statusStateDraft, setStatusStateDraft] = useState(() =>
    createTaskPageGitHubStatusStateDraft(item)
  )
  const [open, setOpen] = useState(false)
  const reqRef = useRef(0)

  const resolvedStatusStateDraft = resolveTaskPageGitHubStatusStateDraft(statusStateDraft, item)
  if (resolvedStatusStateDraft !== statusStateDraft) {
    // Why: item rows can refresh from the GitHub cache while this cell is still
    // mounted; reconcile before paint instead of showing one stale status frame.
    setStatusStateDraft(resolvedStatusStateDraft)
  }
  const localState = resolvedStatusStateDraft.localState
  const updateLocalState = useCallback(
    (nextState: GitHubWorkItem['state']) => {
      setStatusStateDraft((current) =>
        updateTaskPageGitHubStatusLocalState(current, item, nextState)
      )
    },
    [item]
  )

  const handleStateChange = useCallback(
    (newState: 'open' | 'closed') => {
      if (newState === localState || !repo || item.type !== 'issue') {
        return
      }
      reqRef.current += 1
      const reqId = reqRef.current
      updateLocalState(newState)
      patchWorkItem(item.id, { state: newState }, item.repoId)
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
            updateLocalState(newState === 'closed' ? 'open' : 'closed')
            patchWorkItem(
              item.id,
              { state: newState === 'closed' ? 'open' : 'closed' },
              item.repoId
            )
            toast.error(typed.error ?? 'Failed to update state')
          }
        })
        .catch(() => {
          if (reqId !== reqRef.current) {
            return
          }
          updateLocalState(newState === 'closed' ? 'open' : 'closed')
          patchWorkItem(item.id, { state: newState === 'closed' ? 'open' : 'closed' }, item.repoId)
          toast.error('Failed to update state')
        })
    },
    [item, localState, repo, patchWorkItem, updateLocalState]
  )

  if (item.type !== 'issue' || !repo) {
    return (
      <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-700 opacity-70 dark:text-emerald-200">
        Open
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
            'group/status inline-flex cursor-pointer items-center gap-0.5 rounded-full border px-2 py-0.5 text-[10px] font-medium transition hover:brightness-125 hover:ring-1 hover:ring-white/10',
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

function formatPRDelta(item: GitHubWorkItem): string | null {
  const parts: string[] = []
  if (typeof item.additions === 'number') {
    parts.push(`+${item.additions}`)
  }
  if (typeof item.deletions === 'number') {
    parts.push(`-${item.deletions}`)
  }
  if (typeof item.changedFiles === 'number') {
    parts.push(`${item.changedFiles} ${item.changedFiles === 1 ? 'file' : 'files'}`)
  }
  return parts.length > 0 ? parts.join(' ') : null
}

function getReviewTone(item: GitHubWorkItem): string {
  if (item.reviewDecision === 'APPROVED') {
    return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-200'
  }
  if (item.reviewDecision === 'CHANGES_REQUESTED') {
    return 'border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-200'
  }
  if (item.reviewRequests && item.reviewRequests.length > 0) {
    return 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-200'
  }
  return 'border-border/60 bg-background/70 text-muted-foreground'
}

function ReviewChipAvatar({
  reviewer
}: {
  reviewer: GitHubPRPrimaryReviewer | null
}): React.JSX.Element {
  if (reviewer?.avatarUrl) {
    return (
      <img
        src={reviewer.avatarUrl}
        alt=""
        loading="lazy"
        decoding="async"
        title={reviewer.name ? `${reviewer.name} (${reviewer.login})` : reviewer.login}
        className="size-3.5 shrink-0 rounded-full border border-border/50 bg-muted object-cover"
      />
    )
  }
  if (reviewer?.login) {
    return (
      <span
        title={reviewer.login}
        className="inline-flex size-3.5 shrink-0 items-center justify-center rounded-full border border-border/50 bg-muted text-[8px] font-medium text-muted-foreground"
      >
        {reviewer.login.slice(0, 1).toUpperCase()}
      </span>
    )
  }
  return <Users className="size-3 shrink-0" />
}

function GitHubAssigneeAvatar({ assignee }: { assignee: GitHubAssignableUser }): React.JSX.Element {
  if (assignee.avatarUrl) {
    return (
      <img
        src={assignee.avatarUrl}
        alt={assignee.login}
        loading="lazy"
        decoding="async"
        title={assignee.name ? `${assignee.name} (${assignee.login})` : assignee.login}
        className="size-5 rounded-full border border-border/40 bg-muted object-cover"
      />
    )
  }
  return (
    <span
      title={assignee.login}
      className="inline-flex size-5 items-center justify-center rounded-full border border-border/40 bg-muted text-[10px] font-medium text-muted-foreground"
    >
      {assignee.login.slice(0, 1).toUpperCase()}
    </span>
  )
}

function GitHubIssueLabelSelector({
  labels,
  selectedLabels,
  loading,
  error,
  disabled,
  onChange
}: {
  labels: string[]
  selectedLabels: string[]
  loading: boolean
  error: string | null
  disabled: boolean
  onChange: (labels: string[]) => void
}): React.JSX.Element {
  const selectedSet = useMemo(() => new Set(selectedLabels), [selectedLabels])
  const toggleLabel = useCallback(
    (label: string) => {
      onChange(
        selectedSet.has(label)
          ? selectedLabels.filter((name) => name !== label)
          : [...selectedLabels, label]
      )
    },
    [onChange, selectedLabels, selectedSet]
  )

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label className="text-[11px] font-medium text-muted-foreground">Labels</label>
      <Popover>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            disabled={disabled}
            className="h-auto min-h-9 justify-start gap-2 px-3 py-2 text-left"
          >
            {selectedLabels.length === 0 ? (
              <span className="text-muted-foreground">None</span>
            ) : (
              <span className="flex min-w-0 flex-wrap gap-1.5">
                {selectedLabels.map((label) => (
                  <span
                    key={label}
                    className="rounded-full border border-border/50 bg-muted/40 px-2 py-0.5 text-[11px] font-medium"
                  >
                    {label}
                  </span>
                ))}
              </span>
            )}
            {loading ? <LoaderCircle className="ml-auto size-3.5 animate-spin" /> : null}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="popover-scroll-content scrollbar-sleek w-64 p-1" align="start">
          {error ? (
            <div className="px-2 py-2 text-xs text-destructive">{error}</div>
          ) : labels.length === 0 ? (
            <div className="px-2 py-2 text-xs text-muted-foreground">No labels.</div>
          ) : (
            labels.map((label) => (
              <button
                key={label}
                type="button"
                onClick={() => toggleLabel(label)}
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent"
              >
                <span
                  className={cn(
                    'flex size-3.5 shrink-0 items-center justify-center rounded-sm border',
                    selectedSet.has(label)
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-input'
                  )}
                >
                  {selectedSet.has(label) ? <Check className="size-2.5" /> : null}
                </span>
                <span className="min-w-0 truncate">{label}</span>
              </button>
            ))
          )}
        </PopoverContent>
      </Popover>
    </div>
  )
}

function GitHubIssueAssigneeSelector({
  assignees,
  selectedAssignees,
  loading,
  error,
  disabled,
  onChange
}: {
  assignees: GitHubAssignableUser[]
  selectedAssignees: GitHubAssignableUser[]
  loading: boolean
  error: string | null
  disabled: boolean
  onChange: (assignees: GitHubAssignableUser[]) => void
}): React.JSX.Element {
  const selectedLogins = useMemo(
    () => new Set(selectedAssignees.map((assignee) => assignee.login.toLowerCase())),
    [selectedAssignees]
  )
  const toggleAssignee = useCallback(
    (assignee: GitHubAssignableUser) => {
      const key = assignee.login.toLowerCase()
      onChange(
        selectedLogins.has(key)
          ? selectedAssignees.filter((current) => current.login.toLowerCase() !== key)
          : [...selectedAssignees, assignee]
      )
    },
    [onChange, selectedAssignees, selectedLogins]
  )

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label className="text-[11px] font-medium text-muted-foreground">Assignees</label>
      <Popover>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            disabled={disabled}
            className="h-auto min-h-9 justify-start gap-2 px-3 py-2 text-left"
          >
            {selectedAssignees.length === 0 ? (
              <span className="text-muted-foreground">Unassigned</span>
            ) : (
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="flex -space-x-1">
                  {selectedAssignees.slice(0, 3).map((assignee) => (
                    <GitHubAssigneeAvatar key={assignee.login} assignee={assignee} />
                  ))}
                </span>
                <span className="min-w-0 truncate text-xs">
                  {selectedAssignees.map((assignee) => assignee.login).join(', ')}
                </span>
              </span>
            )}
            {loading ? <LoaderCircle className="ml-auto size-3.5 animate-spin" /> : null}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="popover-scroll-content scrollbar-sleek w-72 p-1" align="start">
          {error ? (
            <div className="px-2 py-2 text-xs text-destructive">{error}</div>
          ) : assignees.length === 0 ? (
            <div className="px-2 py-2 text-xs text-muted-foreground">No assignable users.</div>
          ) : (
            assignees.map((assignee) => {
              const selected = selectedLogins.has(assignee.login.toLowerCase())
              return (
                <button
                  key={assignee.login}
                  type="button"
                  onClick={() => toggleAssignee(assignee)}
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent"
                >
                  <span
                    className={cn(
                      'flex size-3.5 shrink-0 items-center justify-center rounded-sm border',
                      selected
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-input'
                    )}
                  >
                    {selected ? <Check className="size-2.5" /> : null}
                  </span>
                  <GitHubAssigneeAvatar assignee={assignee} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{assignee.login}</span>
                    {assignee.name ? (
                      <span className="block truncate text-[11px] text-muted-foreground">
                        {assignee.name}
                      </span>
                    ) : null}
                  </span>
                </button>
              )
            })
          )}
        </PopoverContent>
      </Popover>
    </div>
  )
}

function GHAssigneesCell({
  item,
  repo
}: {
  item: GitHubWorkItem
  repo: Repo | null
}): React.JSX.Element {
  const patchWorkItem = useAppStore((s) => s.patchWorkItem)
  const settings = useAppStore((s) => s.settings)
  const [open, setOpen] = useState(false)
  const [pendingLogin, setPendingLogin] = useState<string | null>(null)
  const assignees = useMemo(() => item.assignees ?? [], [item.assignees])
  const parsed = useMemo(() => parseGitHubIssueOrPRLink(item.url), [item.url])
  const owner = parsed?.slug.owner ?? null
  const repoName = parsed?.slug.repo ?? null
  const seedLogins = useMemo(
    () =>
      assignees
        .map((a) => a.login)
        .sort()
        .filter(Boolean),
    [assignees]
  )
  const metadata = useRepoAssigneesBySlug(
    open ? owner : null,
    open ? repoName : null,
    seedLogins,
    settings
  )

  const toggleAssignee = useCallback(
    async (user: GitHubAssignableUser): Promise<void> => {
      if (item.type !== 'issue' || pendingLogin) {
        return
      }
      const userLoginKey = user.login.toLowerCase()
      const isOn = assignees.some((a) => a.login.toLowerCase() === userLoginKey)
      const previousAssignees = assignees
      const nextAssignees = isOn
        ? assignees.filter((a) => a.login.toLowerCase() !== userLoginKey)
        : [...assignees, user]
      setPendingLogin(user.login)
      patchWorkItem(item.id, { assignees: nextAssignees }, item.repoId)

      try {
        const updates = isOn ? { removeAssignees: [user.login] } : { addAssignees: [user.login] }
        const target = getActiveRuntimeTarget(settings)
        if (owner && repoName) {
          const args = {
            owner,
            repo: repoName,
            number: item.number,
            updates
          }
          const res =
            target.kind === 'environment'
              ? await callRuntimeRpc<Awaited<ReturnType<typeof window.api.gh.updateIssueBySlug>>>(
                  target,
                  'github.project.updateIssueBySlug',
                  args,
                  { timeoutMs: 30_000 }
                )
              : await window.api.gh.updateIssueBySlug(args)
          if (!res.ok) {
            throw new Error(res.error.message)
          }
        } else if (repo) {
          const res =
            target.kind === 'environment'
              ? await callRuntimeRpc<{ ok?: boolean; error?: string }>(
                  target,
                  'github.updateIssue',
                  { repo: repo.id, number: item.number, updates },
                  { timeoutMs: 30_000 }
                )
              : await window.api.gh.updateIssue({
                  repoPath: repo.path,
                  repoId: repo.id,
                  number: item.number,
                  updates
                })
          if (res && res.ok === false) {
            throw new Error(res.error)
          }
        } else {
          throw new Error('No GitHub repository context available for this issue.')
        }
      } catch (err) {
        patchWorkItem(item.id, { assignees: previousAssignees }, item.repoId)
        toast.error(err instanceof Error ? err.message : 'Failed to update assignees.')
      } finally {
        setPendingLogin(null)
      }
    },
    [
      assignees,
      item.id,
      item.number,
      item.repoId,
      item.type,
      owner,
      patchWorkItem,
      pendingLogin,
      repo,
      repoName,
      settings
    ]
  )

  const triggerContent =
    assignees.length > 0 ? (
      <>
        <div className="flex min-w-0 -space-x-1 overflow-hidden">
          {assignees.slice(0, 3).map((assignee) => (
            <GitHubAssigneeAvatar key={assignee.login} assignee={assignee} />
          ))}
        </div>
        {assignees.length > 3 ? (
          <span className="ml-1 shrink-0 text-[10px] font-medium text-muted-foreground">
            +{assignees.length - 3}
          </span>
        ) : null}
      </>
    ) : (
      <span className="text-xs text-muted-foreground/60">-</span>
    )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={
            assignees.length
              ? `Assigned to ${assignees.map((a) => a.login).join(', ')}`
              : 'Assign issue'
          }
          aria-busy={pendingLogin !== null}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          className={cn(
            'inline-flex h-6 max-w-full items-center gap-1 text-left transition disabled:opacity-60',
            assignees.length > 0
              ? 'rounded-full border border-border/40 bg-background/70 px-1.5 hover:bg-muted/60'
              : 'w-full rounded-sm border border-transparent bg-transparent px-1 hover:bg-muted/40'
          )}
        >
          {triggerContent}
          {pendingLogin ? (
            <LoaderCircle className="size-3 shrink-0 animate-spin text-muted-foreground" />
          ) : assignees.length > 0 ? (
            <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
          ) : null}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="popover-scroll-content scrollbar-sleek w-64 p-1"
        onClick={(event) => event.stopPropagation()}
      >
        {!owner || !repoName ? (
          <div className="px-2 py-2 text-xs text-muted-foreground">Issue has no repo slug.</div>
        ) : metadata.loading ? (
          <div className="px-2 py-2 text-xs text-muted-foreground">Loading…</div>
        ) : metadata.error ? (
          <div className="px-2 py-2 text-xs text-destructive">{metadata.error}</div>
        ) : metadata.data.length === 0 ? (
          <div className="px-2 py-2 text-xs text-muted-foreground">No assignable users.</div>
        ) : (
          metadata.data.map((user) => {
            const isOn = assignees.some((a) => a.login.toLowerCase() === user.login.toLowerCase())
            const pending = pendingLogin === user.login
            return (
              <button
                key={user.login}
                type="button"
                disabled={pendingLogin !== null}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-muted/50 disabled:opacity-60"
                onClick={(event) => {
                  event.stopPropagation()
                  void toggleAssignee(user)
                }}
              >
                <span
                  className={cn(
                    'flex size-3.5 shrink-0 items-center justify-center rounded-sm border',
                    isOn ? 'border-primary bg-primary text-primary-foreground' : 'border-input'
                  )}
                >
                  {pending ? (
                    <LoaderCircle className="size-3 animate-spin" />
                  ) : isOn ? (
                    <Check className="size-3" />
                  ) : null}
                </span>
                {user.avatarUrl ? (
                  <img src={user.avatarUrl} alt="" className="size-5 shrink-0 rounded-full" />
                ) : (
                  <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground">
                    {user.login.slice(0, 1).toUpperCase()}
                  </span>
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{user.login}</span>
                  {user.name ? (
                    <span className="block truncate text-[11px] text-muted-foreground">
                      {user.name}
                    </span>
                  ) : null}
                </span>
              </button>
            )
          })
        )}
      </PopoverContent>
    </Popover>
  )
}

function getChecksLabel(item: GitHubWorkItem): string {
  const summary = item.checksSummary
  if (!summary) {
    return 'Checks'
  }
  if (summary.total === 0) {
    return 'No checks'
  }
  if (summary.failed > 0) {
    return `${summary.failed} failing`
  }
  if (summary.pending > 0) {
    return `${summary.pending} pending`
  }
  return `${summary.passed}/${summary.total} passed`
}

function getChecksTone(item: GitHubWorkItem): string {
  const state = item.checksSummary?.state
  if (state === 'success') {
    return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-200'
  }
  if (state === 'failure') {
    return 'border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-200'
  }
  if (state === 'pending') {
    return 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-200'
  }
  return 'border-border/60 bg-background/70 text-muted-foreground'
}

function sameOptionalGitHubOwnerRepo(
  left: GitHubOwnerRepo | null | undefined,
  right: GitHubOwnerRepo | null | undefined
): boolean {
  const leftValue = left ?? null
  const rightValue = right ?? null
  return leftValue === null && rightValue === null
    ? true
    : sameGitHubOwnerRepo(leftValue, rightValue)
}

function mergeReviewerSuggestions(
  users: GitHubAssignableUser[],
  seedUsers: GitHubAssignableUser[]
): GitHubAssignableUser[] {
  const byLogin = new Map<string, GitHubAssignableUser>()
  for (const user of [...seedUsers, ...users]) {
    const key = user.login.toLowerCase()
    const existing = byLogin.get(key)
    if (!existing) {
      byLogin.set(key, user)
      continue
    }
    if (!existing.avatarUrl && user.avatarUrl) {
      byLogin.set(key, { ...existing, avatarUrl: user.avatarUrl })
    }
  }
  return Array.from(byLogin.values()).sort((a, b) => a.login.localeCompare(b.login))
}

function buildRequestedReviewUsers(
  logins: string[],
  candidates: GitHubAssignableUser[],
  existingRequests: GitHubAssignableUser[]
): GitHubAssignableUser[] {
  const byLogin = new Map<string, GitHubAssignableUser>()
  for (const user of existingRequests) {
    byLogin.set(user.login.toLowerCase(), user)
  }
  const candidatesByLogin = new Map(candidates.map((user) => [user.login.toLowerCase(), user]))
  for (const login of logins) {
    const key = login.toLowerCase()
    if (byLogin.has(key)) {
      continue
    }
    byLogin.set(key, candidatesByLogin.get(key) ?? { login, name: null, avatarUrl: '' })
  }
  return Array.from(byLogin.values())
}

function PRReviewCell({
  item,
  repo
}: {
  item: GitHubWorkItem
  repo: Repo | null
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [reviewerInput, setReviewerInput] = useState('')
  const [localReviewRequests, setLocalReviewRequests] = useState<GitHubAssignableUser[]>(
    () => item.reviewRequests ?? []
  )
  const [reviewRequestsSource, setReviewRequestsSource] = useState(() => ({
    itemId: item.id,
    repoId: item.repoId,
    reviewRequests: item.reviewRequests
  }))
  const patchWorkItem = useAppStore((s) => s.patchWorkItem)
  const [activeReviewerCursor, setActiveReviewerCursor] = useState({ resetKey: '', index: 0 })
  const [submitting, setSubmitting] = useState(false)
  const settings = useAppStore((s) => s.settings)
  const reviewerInputRef = useRef<HTMLInputElement | null>(null)
  const reviewerInputFocusFrameRef = useRef<number | null>(null)

  const cancelReviewerInputFocusFrame = useCallback((): void => {
    if (reviewerInputFocusFrameRef.current === null) {
      return
    }
    cancelAnimationFrame(reviewerInputFocusFrameRef.current)
    reviewerInputFocusFrameRef.current = null
  }, [])

  const setReviewerInputNode = useCallback(
    (node: HTMLInputElement | null): void => {
      // Why: the queued picker focus is only valid while this input is mounted.
      if (!node) {
        cancelReviewerInputFocusFrame()
      }
      reviewerInputRef.current = node
    },
    [cancelReviewerInputFocusFrame]
  )

  // Why: reviewer edits are optimistic, but item switches/refetches must clear
  // stale local requests before paint; a passive Effect leaves one stale render.
  if (
    reviewRequestsSource.itemId !== item.id ||
    reviewRequestsSource.repoId !== item.repoId ||
    reviewRequestsSource.reviewRequests !== item.reviewRequests
  ) {
    setReviewRequestsSource({
      itemId: item.id,
      repoId: item.repoId,
      reviewRequests: item.reviewRequests
    })
    setLocalReviewRequests(item.reviewRequests ?? [])
  }

  const reviewerSeedUsers = useMemo<GitHubAssignableUser[]>(() => {
    const byLogin = new Map<string, GitHubAssignableUser>()
    const add = (user: GitHubAssignableUser): void => {
      if (!user.login) {
        return
      }
      byLogin.set(user.login.toLowerCase(), user)
    }
    for (const user of localReviewRequests) {
      add(user)
    }
    for (const review of item.latestReviews ?? []) {
      add({
        login: review.login,
        name: null,
        avatarUrl: review.avatarUrl ?? ''
      })
    }
    if (item.author) {
      add({ login: item.author, name: null, avatarUrl: '' })
    }
    return Array.from(byLogin.values())
  }, [item.author, item.latestReviews, localReviewRequests])

  const reviewSlug = useMemo(() => parseGitHubIssueOrPRLink(item.url)?.slug ?? null, [item.url])
  const reviewerMetadata = useRepoAssigneesBySlug(
    open && reviewSlug ? reviewSlug.owner : null,
    open && reviewSlug ? reviewSlug.repo : null,
    reviewerSeedUsers.map((user) => user.login),
    settings
  )

  const authorLogin = item.author?.toLowerCase() ?? null
  const reviewerCandidates = useMemo(
    () =>
      mergeReviewerSuggestions(reviewerMetadata.data, reviewerSeedUsers).filter(
        (user) => user.login.toLowerCase() !== authorLogin
      ),
    [authorLogin, reviewerMetadata.data, reviewerSeedUsers]
  )
  const reviewerCandidatesByLogin = useMemo(
    () => new Map(reviewerCandidates.map((user) => [user.login.toLowerCase(), user])),
    [reviewerCandidates]
  )
  const selectedReviewerLogins = useMemo(
    () =>
      new Set(
        localReviewRequests.map((reviewer) => reviewer.login.trim().toLowerCase()).filter(Boolean)
      ),
    [localReviewRequests]
  )
  const reviewerQuery = reviewerInput.trim().replace(/^@/, '').toLowerCase()
  const filteredReviewerCandidates = useMemo(() => {
    const query = reviewerQuery
    return reviewerCandidates
      .filter((user) => {
        const login = user.login.toLowerCase()
        return (
          query.length === 0 ||
          login.includes(query) ||
          (user.name ?? '').toLowerCase().includes(query)
        )
      })
      .sort((a, b) => {
        const aLogin = a.login.toLowerCase()
        const bLogin = b.login.toLowerCase()
        const aStarts = aLogin.startsWith(query)
        const bStarts = bLogin.startsWith(query)
        if (aStarts !== bStarts) {
          return aStarts ? -1 : 1
        }
        return a.login.localeCompare(b.login)
      })
  }, [reviewerCandidates, reviewerQuery])
  const suggestedReviewerRows = useMemo(
    () =>
      reviewerQuery.length === 0
        ? reviewerSeedUsers
            .filter((user) => !selectedReviewerLogins.has(user.login.toLowerCase()))
            .filter((user) => user.login.toLowerCase() !== authorLogin)
            .map((user) => reviewerCandidatesByLogin.get(user.login.toLowerCase()) ?? user)
            .slice(0, 1)
        : [],
    [
      authorLogin,
      reviewerCandidatesByLogin,
      reviewerQuery.length,
      reviewerSeedUsers,
      selectedReviewerLogins
    ]
  )
  const everyoneElseReviewerRows = useMemo(() => {
    const suggestedLogins = new Set(suggestedReviewerRows.map((user) => user.login.toLowerCase()))
    return filteredReviewerCandidates.filter(
      (user) => !suggestedLogins.has(user.login.toLowerCase())
    )
  }, [filteredReviewerCandidates, suggestedReviewerRows])
  const actionableReviewerRows = useMemo(
    () => [...suggestedReviewerRows, ...everyoneElseReviewerRows],
    [everyoneElseReviewerRows, suggestedReviewerRows]
  )

  const reviewerCursorResetKey = `${reviewerQuery}\u0000${actionableReviewerRows.length}`
  if (activeReviewerCursor.resetKey !== reviewerCursorResetKey) {
    setActiveReviewerCursor({ resetKey: reviewerCursorResetKey, index: 0 })
  }
  const activeReviewerIndex =
    activeReviewerCursor.resetKey === reviewerCursorResetKey ? activeReviewerCursor.index : 0
  const setActiveReviewerIndex = useCallback(
    (nextIndex: number | ((current: number) => number)): void => {
      setActiveReviewerCursor((current) => {
        const currentIndex = current.resetKey === reviewerCursorResetKey ? current.index : 0
        return {
          resetKey: reviewerCursorResetKey,
          index: typeof nextIndex === 'function' ? nextIndex(currentIndex) : nextIndex
        }
      })
    },
    [reviewerCursorResetKey]
  )

  if (item.type !== 'pr') {
    return <span className="text-[11px] text-muted-foreground">Issue</span>
  }

  const itemWithLocalReviewRequests = { ...item, reviewRequests: localReviewRequests }
  const primaryReviewer = getGitHubPRPrimaryReviewer(itemWithLocalReviewRequests)
  const hasReviewerMetadata =
    item.reviewDecision !== undefined ||
    localReviewRequests.length > 0 ||
    item.reviewRequests !== undefined ||
    item.latestReviews !== undefined

  const handleRequestReview = async (requestedLogins?: string[]): Promise<void> => {
    if (!repo || submitting) {
      return
    }
    const logins = normalizeGitHubReviewerLogins(
      requestedLogins ?? reviewerInput.split(/[\s,]+/),
      selectedReviewerLogins
    )
    if (logins.length === 0) {
      toast.error('Enter a reviewer')
      return
    }
    if (localReviewRequests.length + logins.length > 15) {
      toast.error('You can request up to 15 reviewers')
      return
    }
    setSubmitting(true)
    try {
      const target = getActiveRuntimeTarget(settings)
      const result =
        target.kind === 'environment'
          ? await callRuntimeRpc<{ ok: boolean; error?: string }>(
              target,
              'github.requestPRReviewers',
              { repo: repo.id, prNumber: item.number, reviewers: logins },
              { timeoutMs: 30_000 }
            )
          : await window.api.gh.requestPRReviewers({
              repoPath: repo.path,
              repoId: repo.id,
              prNumber: item.number,
              reviewers: logins
            })
      if (result.ok) {
        toast.success('Reviewer requested')
        const nextReviewRequests = buildRequestedReviewUsers(
          logins,
          reviewerCandidates,
          localReviewRequests
        )
        setLocalReviewRequests(nextReviewRequests)
        patchWorkItem(item.id, { reviewRequests: nextReviewRequests }, item.repoId)
        setReviewerInput('')
      } else {
        toast.error(result.error)
      }
    } catch {
      toast.error('Failed to request reviewer')
    } finally {
      setSubmitting(false)
    }
  }

  const handleRemoveReviewers = async (reviewersToRemove: string[]): Promise<void> => {
    if (!repo || submitting) {
      return
    }
    const selected = new Set(localReviewRequests.map((reviewer) => reviewer.login.toLowerCase()))
    const logins = reviewersToRemove
      .map((reviewer) => reviewer.trim().replace(/^@/, ''))
      .filter((reviewer) => reviewer.length > 0 && selected.has(reviewer.toLowerCase()))
    if (logins.length === 0) {
      return
    }
    setSubmitting(true)
    try {
      const target = getActiveRuntimeTarget(settings)
      const result =
        target.kind === 'environment'
          ? await callRuntimeRpc<{ ok: boolean; error?: string }>(
              target,
              'github.removePRReviewers',
              { repo: repo.id, prNumber: item.number, reviewers: logins },
              { timeoutMs: 30_000 }
            )
          : await window.api.gh.removePRReviewers({
              repoPath: repo.path,
              repoId: repo.id,
              prNumber: item.number,
              reviewers: logins
            })
      if (result.ok) {
        toast.success(logins.length === 1 ? 'Reviewer removed' : 'Reviewers removed')
        const removed = new Set(logins.map((login) => login.toLowerCase()))
        const nextReviewRequests = localReviewRequests.filter(
          (reviewer) => !removed.has(reviewer.login.toLowerCase())
        )
        setLocalReviewRequests(nextReviewRequests)
        patchWorkItem(item.id, { reviewRequests: nextReviewRequests }, item.repoId)
        setReviewerInput('')
      } else {
        toast.error(result.error)
      }
    } catch {
      toast.error('Failed to remove reviewer')
    } finally {
      setSubmitting(false)
    }
  }

  const requestReviewer = async (reviewer: GitHubAssignableUser): Promise<void> => {
    // Close the popover immediately so the UI feels responsive; the GitHub
    // request/remove runs in the background and toasts on completion.
    setOpen(false)
    setReviewerInput('')
    await (selectedReviewerLogins.has(reviewer.login.toLowerCase())
      ? handleRemoveReviewers([reviewer.login])
      : handleRequestReview([reviewer.login]))
  }

  const handleReviewerPickerOpenChange = (nextOpen: boolean): void => {
    setOpen(nextOpen)
    if (nextOpen) {
      cancelReviewerInputFocusFrame()
      reviewerInputFocusFrameRef.current = requestAnimationFrame(() => {
        reviewerInputFocusFrameRef.current = null
        reviewerInputRef.current?.focus()
      })
      return
    }
    cancelReviewerInputFocusFrame()
    setReviewerInput('')
  }

  const renderReviewerPickerRow = (
    reviewer: GitHubAssignableUser,
    options: { suggested: boolean; activeIndex: number }
  ): React.JSX.Element => {
    const selected = selectedReviewerLogins.has(reviewer.login.toLowerCase())
    const active = actionableReviewerRows[activeReviewerIndex]?.login === reviewer.login
    return (
      <button
        key={`${options.suggested ? 'suggested' : 'reviewer'}:${reviewer.login}`}
        type="button"
        className={cn(
          'flex min-h-10 w-full items-center gap-2 border-b border-border/50 px-3 py-2 text-left text-[13px] outline-none last:border-b-0 hover:bg-accent/70',
          active && 'bg-accent text-accent-foreground',
          selected && 'font-medium'
        )}
        onMouseEnter={() => setActiveReviewerIndex(options.activeIndex)}
        onMouseDown={(event) => {
          event.preventDefault()
          void requestReviewer(reviewer)
        }}
      >
        <span className="flex size-4 shrink-0 items-center justify-center text-foreground">
          {selected ? <Check className="size-3.5" /> : null}
        </span>
        {reviewer.avatarUrl ? (
          <img src={reviewer.avatarUrl} alt="" className="size-5 shrink-0 rounded-full" />
        ) : (
          <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground">
            {reviewer.login.slice(0, 1).toUpperCase()}
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate">
            <span className="font-semibold text-foreground">{reviewer.login}</span>
            {reviewer.name ? (
              <span className="ml-1 font-normal text-muted-foreground">{reviewer.name}</span>
            ) : null}
          </span>
          {options.suggested ? (
            <span className="block truncate text-[12px] leading-4 text-muted-foreground">
              Recently active in this pull request
            </span>
          ) : null}
        </span>
      </button>
    )
  }

  return (
    <Popover open={open} onOpenChange={handleReviewerPickerOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          onClick={(event) => event.stopPropagation()}
          className={cn(
            'inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium transition hover:brightness-110',
            getReviewTone(itemWithLocalReviewRequests)
          )}
        >
          <ReviewChipAvatar reviewer={primaryReviewer} />
          <span className="truncate">{getGitHubPRReviewLabel(itemWithLocalReviewRequests)}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[330px] overflow-hidden rounded-md border-border/70 p-0"
        align="start"
        onClick={(event) => event.stopPropagation()}
        onOpenAutoFocus={(event) => {
          event.preventDefault()
        }}
      >
        <div className="border-b border-border/70 px-3 py-2">
          <div className="text-[13px] font-semibold text-foreground">
            Request up to 15 reviewers
          </div>
        </div>
        <div className="border-b border-border/70 p-3">
          <Input
            ref={setReviewerInputNode}
            value={reviewerInput}
            onChange={(event) => setReviewerInput(event.target.value)}
            placeholder="Type or choose a user"
            disabled={!repo || submitting}
            className="h-8 rounded-md bg-background px-2 text-[13px]"
            aria-label="Type or choose a user"
            aria-autocomplete="list"
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown' && actionableReviewerRows.length > 0) {
                event.preventDefault()
                setActiveReviewerIndex((current) => (current + 1) % actionableReviewerRows.length)
                return
              }
              if (event.key === 'ArrowUp' && actionableReviewerRows.length > 0) {
                event.preventDefault()
                setActiveReviewerIndex(
                  (current) =>
                    (current - 1 + actionableReviewerRows.length) % actionableReviewerRows.length
                )
                return
              }
              if (event.key === 'Enter') {
                event.preventDefault()
                const activeReviewer = actionableReviewerRows[activeReviewerIndex]
                if (activeReviewer) {
                  void requestReviewer(activeReviewer)
                  return
                }
                void handleRequestReview()
                return
              }
              if (event.key === 'Escape') {
                event.preventDefault()
                handleReviewerPickerOpenChange(false)
              }
            }}
          />
        </div>
        <div className="max-h-[300px] overflow-y-auto scrollbar-sleek">
          {reviewerMetadata.loading ? (
            <div className="px-3 py-2 text-[13px] text-muted-foreground">Loading…</div>
          ) : filteredReviewerCandidates.length > 0 ? (
            <>
              {suggestedReviewerRows.length > 0 ? (
                <>
                  <div className="border-b border-border/70 bg-muted/50 px-3 py-1.5 text-[12px] font-semibold text-foreground">
                    Suggestions
                  </div>
                  {suggestedReviewerRows.map((reviewer, index) =>
                    renderReviewerPickerRow(reviewer, { suggested: true, activeIndex: index })
                  )}
                </>
              ) : null}
              <div className="border-b border-border/70 bg-muted/50 px-3 py-1.5 text-[12px] font-semibold text-foreground">
                Everyone else
              </div>
              {everyoneElseReviewerRows.length > 0 ? (
                everyoneElseReviewerRows.map((reviewer, index) =>
                  renderReviewerPickerRow(reviewer, {
                    suggested: false,
                    activeIndex: suggestedReviewerRows.length + index
                  })
                )
              ) : (
                <div className="px-3 py-2 text-[13px] text-muted-foreground">
                  No matching reviewers.
                </div>
              )}
            </>
          ) : (
            <div className="px-3 py-2 text-[13px] text-muted-foreground">
              {reviewerMetadata.error ??
                (hasReviewerMetadata
                  ? 'No matching reviewers.'
                  : 'Open the PR details to view current reviewers.')}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

function PRChecksCell({
  item,
  onOpen,
  onLoadChecks
}: {
  item: GitHubWorkItem
  onOpen: () => void
  onLoadChecks: () => void
}): React.JSX.Element {
  const triggerRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    if (item.type !== 'pr' || item.checksSummary) {
      return
    }
    const node = triggerRef.current
    if (!node || typeof IntersectionObserver === 'undefined') {
      return
    }
    let requested = false
    const observer = new IntersectionObserver(
      (entries) => {
        if (requested || !entries.some((entry) => entry.isIntersecting)) {
          return
        }
        requested = true
        onLoadChecks()
        observer.disconnect()
      },
      { rootMargin: '160px 0px' }
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [item.checksSummary, item.type, onLoadChecks])

  if (item.type !== 'pr') {
    return <span className="text-[11px] text-muted-foreground">Issue</span>
  }
  const summary = item.checksSummary
  const Icon =
    summary?.state === 'success'
      ? CheckCircle2
      : summary?.state === 'failure'
        ? AlertCircle
        : summary?.state === 'pending'
          ? Clock3
          : Minus
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          ref={triggerRef}
          type="button"
          onFocus={onLoadChecks}
          onMouseEnter={onLoadChecks}
          onClick={(event) => {
            event.stopPropagation()
            onLoadChecks()
            onOpen()
          }}
          className={cn(
            'inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium transition hover:brightness-110',
            getChecksTone(item)
          )}
        >
          <Icon className="size-3" />
          <span className="truncate">{getChecksLabel(item)}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        Open PR checks
      </TooltipContent>
    </Tooltip>
  )
}

function PRMergeCell({
  item,
  repo,
  onRefresh
}: {
  item: GitHubWorkItem
  repo: Repo | null
  onRefresh: () => void
}): React.JSX.Element {
  const [merging, setMerging] = useState(false)
  const confirm = useConfirmationDialog()
  if (item.type !== 'pr') {
    return <span className="text-[11px] text-muted-foreground">Issue</span>
  }
  const mergePresentation = presentGitHubPRMergeState(item)
  const mergeMethods = resolveGitHubPRMergeMethods(item.mergeMethodSettings)
  const mergeDisabled = !repo || merging || !mergePresentation.directMergeAvailable

  const handleMerge = async (method: GitHubPRMergeMethod): Promise<void> => {
    if (!repo || mergeDisabled) {
      return
    }
    const label = GITHUB_PR_MERGE_METHOD_LABELS[method]
    const confirmed = await confirm({
      title: `${label} PR #${item.number}?`,
      description: 'This will update the pull request on GitHub.',
      confirmLabel: label
    })
    if (!confirmed) {
      return
    }
    setMerging(true)
    try {
      const result = await window.api.gh.mergePR({
        repoPath: repo.path,
        repoId: repo.id,
        prNumber: item.number,
        method,
        prRepo: item.prRepo ?? null
      })
      if (result.ok) {
        toast.success('Pull request merged')
        onRefresh()
      } else {
        toast.error(result.error)
      }
    } catch {
      toast.error('Failed to merge pull request')
    } finally {
      setMerging(false)
    }
  }

  const handleAutoMerge = async (): Promise<void> => {
    if (!repo || !mergePresentation.autoMergeAction) {
      return
    }
    const enabled = mergePresentation.autoMergeAction.kind === 'enable'
    setMerging(true)
    try {
      const result = await window.api.gh.setPRAutoMerge({
        repoPath: repo.path,
        repoId: repo.id,
        prNumber: item.number,
        enabled,
        prRepo: item.prRepo ?? null
      })
      if (result.ok) {
        toast.success(enabled ? 'Auto-merge enabled' : 'Auto-merge disabled')
        onRefresh()
      } else {
        toast.error(result.error)
      }
    } catch {
      toast.error(enabled ? 'Failed to enable auto-merge' : 'Failed to disable auto-merge')
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
                <LoaderCircle className="size-3 animate-spin" />
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
          <DropdownMenuItem disabled={!repo || merging} onSelect={() => void handleAutoMerge()}>
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
        <DropdownMenuItem onSelect={() => window.api.shell.openUrl(item.url)}>
          <ExternalLink className="size-4" />
          Open GitHub merge box
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
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
    'inline-flex w-24 items-center justify-center gap-0.5 rounded-md px-2 py-1 text-sm text-muted-foreground transition hover:bg-muted/60 hover:text-foreground disabled:pointer-events-none disabled:opacity-40'
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
  const openTaskPage = useAppStore((s) => s.openTaskPage)
  const closeTaskPage = useAppStore((s) => s.closeTaskPage)
  const activeModal = useAppStore((s) => s.activeModal)
  const repos = useAppStore((s) => s.repos)
  const repoMap = useRepoMap()
  const allWorktrees = useAllWorktrees()
  const openModal = useAppStore((s) => s.openModal)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const fetchWorkItemsAcrossRepos = useAppStore((s) => s.fetchWorkItemsAcrossRepos)
  const fetchPRChecks = useAppStore((s) => s.fetchPRChecks)
  const getCachedWorkItems = useAppStore((s) => s.getCachedWorkItems)
  const setIssueSourcePreference = useAppStore((s) => s.setIssueSourcePreference)
  // Why: bumped by `setIssueSourcePreference` after cache eviction so the
  // fetch effect below re-runs and repopulates work-items against the new
  // source. Eviction alone isn't enough because the effect's deps don't
  // include `workItemsCache`.
  const workItemsInvalidationNonce = useAppStore((s) => s.workItemsInvalidationNonce)
  const linearStatus = useAppStore((s) => s.linearStatus)
  const linearStatusChecked = useAppStore((s) => s.linearStatusChecked)
  const preflightStatus = useAppStore((s) => s.preflightStatus)
  const preflightStatusChecked = useAppStore((s) => s.preflightStatusChecked)
  const selectLinearWorkspace = useAppStore((s) => s.selectLinearWorkspace)
  const searchLinearIssues = useAppStore((s) => s.searchLinearIssues)
  const listLinearIssues = useAppStore((s) => s.listLinearIssues)
  const getCachedLinearIssues = useAppStore((s) => s.getCachedLinearIssues)
  const getCachedLinearTeams = useAppStore((s) => s.getCachedLinearTeams)
  const listLinearTeams = useAppStore((s) => s.listLinearTeams)
  const getCachedLinearProjects = useAppStore((s) => s.getCachedLinearProjects)
  const listLinearProjectsFromStore = useAppStore((s) => s.listLinearProjects)
  const fetchLinearProject = useAppStore((s) => s.fetchLinearProject)
  const listLinearProjectIssues = useAppStore((s) => s.listLinearProjectIssues)
  const getCachedLinearCustomViews = useAppStore((s) => s.getCachedLinearCustomViews)
  const listLinearCustomViews = useAppStore((s) => s.listLinearCustomViews)
  const fetchLinearCustomView = useAppStore((s) => s.fetchLinearCustomView)
  const listLinearCustomViewIssues = useAppStore((s) => s.listLinearCustomViewIssues)
  const listLinearCustomViewProjects = useAppStore((s) => s.listLinearCustomViewProjects)
  const patchLinearIssue = useAppStore((s) => s.patchLinearIssue)
  const checkLinearConnection = useAppStore((s) => s.checkLinearConnection)
  const refreshPreflightStatus = useAppStore((s) => s.refreshPreflightStatus)
  const jiraStatus = useAppStore((s) => s.jiraStatus)
  const jiraStatusChecked = useAppStore((s) => s.jiraStatusChecked)
  const connectJira = useAppStore((s) => s.connectJira)
  const selectJiraSite = useAppStore((s) => s.selectJiraSite)
  const searchJiraIssues = useAppStore((s) => s.searchJiraIssues)
  const listJiraIssues = useAppStore((s) => s.listJiraIssues)
  const checkJiraConnection = useAppStore((s) => s.checkJiraConnection)
  const submitShortcutLabel = getScreenSubmitShortcutLabel()
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
  const selectedLinearWorkspace =
    selectedLinearWorkspaceId && selectedLinearWorkspaceId !== 'all'
      ? (linearWorkspaces.find((workspace) => workspace.id === selectedLinearWorkspaceId) ?? null)
      : null
  const jiraSites = jiraStatus.sites ?? []
  const selectedJiraSiteId =
    jiraStatus.selectedSiteId ?? jiraStatus.activeSiteId ?? jiraSites[0]?.id ?? null
  const preferredVisibleTaskProviders = useMemo(
    () => normalizeVisibleTaskProviders(settings?.visibleTaskProviders),
    [settings?.visibleTaskProviders]
  )
  const defaultTaskSource = settings?.defaultTaskSource ?? 'github'
  const visibleTaskProviders = useMemo(
    () =>
      restoreAvailableDefaultTaskProvider(
        preferredVisibleTaskProviders,
        {
          gitlabInstalled: preflightStatus?.glab?.installed === true,
          linearConnected: linearStatus.connected === true
        },
        defaultTaskSource
      ),
    [
      defaultTaskSource,
      linearStatus.connected,
      preferredVisibleTaskProviders,
      preflightStatus?.glab?.installed
    ]
  )
  const visibleSourceOptions = useMemo(
    () => SOURCE_OPTIONS.filter((source) => visibleTaskProviders.includes(source.id)),
    [visibleTaskProviders]
  )
  const hideTaskSource = useCallback(
    (provider: TaskProvider, label: string) => {
      const visibleWithoutProvider = preferredVisibleTaskProviders.filter(
        (visibleProvider) => visibleProvider !== provider
      )
      // Why: an empty provider list normalizes back to "all providers"; keep
      // one other source visible so opting out actually hides this provider.
      const nextVisibleTaskProviders: TaskProvider[] =
        visibleWithoutProvider.length > 0 ? visibleWithoutProvider : ['github']
      const nextDefaultTaskSource = resolveVisibleTaskProvider(
        defaultTaskSource,
        nextVisibleTaskProviders
      )

      void updateSettings({
        visibleTaskProviders: nextVisibleTaskProviders,
        defaultTaskSource: nextDefaultTaskSource
      }).catch(() => {
        toast.error(`Failed to hide ${label}.`)
      })
    },
    [defaultTaskSource, preferredVisibleTaskProviders, updateSettings]
  )

  // Why: seed the preset + query from the user's saved default synchronously
  // so the first fetch effect issues exactly one request keyed to the final
  // query. Previously a separate effect "re-seeded" these after mount, which
  // caused a throwaway empty-query fetch followed by a second fetch for the
  // real default — doubling the time-to-first-paint of the list.
  const defaultTaskViewPreset = normalizeGitHubTaskPreset(settings?.defaultTaskViewPreset ?? 'all')
  const initialTaskQuery = getTaskPresetQuery(defaultTaskViewPreset)

  const preferredTaskSource = pageData.taskSource ?? defaultTaskSource
  const [taskSource, setTaskSource] = useState<TaskSource>(
    resolveVisibleTaskProvider(preferredTaskSource, visibleTaskProviders)
  )
  const taskSourceManuallyChangedRef = useRef(false)
  const lastPageTaskSourceRef = useRef(pageData.taskSource)
  const taskResumeAppliedRef = useRef(false)
  const githubSearchPersistReadyRef = useRef(false)
  const linearSearchPersistReadyRef = useRef(false)
  const jiraSearchPersistReadyRef = useRef(false)
  const [taskResumeApplied, setTaskResumeApplied] = useState(false)

  // Why: pageData.taskSource changes when the user clicks a specific source
  // icon in the sidebar while the task page is already open. useState only
  // initializes once, so sync from the store when the value changes.
  useEffect(() => {
    const pageTaskSourceChanged = lastPageTaskSourceRef.current !== pageData.taskSource
    lastPageTaskSourceRef.current = pageData.taskSource
    if (pageData.taskSource) {
      if (pageTaskSourceChanged) {
        taskSourceManuallyChangedRef.current = false
      } else if (taskSourceManuallyChangedRef.current) {
        return
      }
      setTaskSource(resolveVisibleTaskProvider(pageData.taskSource, visibleTaskProviders))
    }
  }, [pageData.taskSource, visibleTaskProviders])

  useEffect(() => {
    if (taskSourceManuallyChangedRef.current) {
      return
    }
    // Why: GitLab/Linear availability hydrates after mount. If the saved
    // default was unavailable during the first render, restore it once the
    // relevant check proves the provider can be shown.
    if (visibleTaskProviders.includes(preferredTaskSource) && taskSource !== preferredTaskSource) {
      setTaskSource(preferredTaskSource)
    }
  }, [preferredTaskSource, taskSource, visibleTaskProviders])

  useEffect(() => {
    if (!visibleTaskProviders.includes(taskSource)) {
      setTaskSource(resolveVisibleTaskProvider(settings?.defaultTaskSource, visibleTaskProviders))
    }
  }, [settings?.defaultTaskSource, taskSource, visibleTaskProviders])

  // Why: Project mode is a sub-tab within the GitHub source. Visible whenever
  // the user is on the GitHub task source — actual entry into Project mode is
  // gated on a non-null `activeProject` once they pick one.
  const projectModeVisible = taskSource === 'github'
  const [githubMode, setGithubMode] = useState<'items' | 'project'>('items')

  // ── GitLab task-source state ──────────────────────────────────────
  // Why: parallel to Linear's slim per-source state. Skips workItemsCache
  // and cross-repo aggregation in v1 — the GitLab list fetches directly
  // from `window.api.gl.listMRs` / `listIssues` for the primary repo.
  const [gitlabFilter, setGitlabFilter] = useState<GitLabTaskFilter | GitLabIssueFilter>('opened')
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
  const [gitlabView, setGitlabView] = useState<'issues' | 'mrs' | 'todos'>('mrs')
  const [gitlabTodos, setGitlabTodos] = useState<GitLabTodo[]>([])
  const [gitlabTodosLoading, setGitlabTodosLoading] = useState(false)

  const gitlabFilterIsValid =
    gitlabView === 'issues'
      ? isGitLabIssueFilter(gitlabFilter)
      : gitlabView === 'mrs'
        ? isGitLabMRFilter(gitlabFilter)
        : true
  const activeGitlabFilter = gitlabFilterIsValid ? gitlabFilter : 'opened'
  // Why: Issues and MRs expose different filter sets; repair before commit so
  // fetch Effects never issue `glab` with a stale filter from the other view.
  if (!gitlabFilterIsValid) {
    setGitlabFilter('opened')
  }

  const displayedGitLabItems = useMemo(() => {
    if (gitlabView === 'issues') {
      return gitlabItems.filter((item) => item.type === 'issue')
    }
    if (gitlabView === 'mrs') {
      return gitlabItems.filter((item) => item.type === 'mr')
    }
    return gitlabItems
  }, [gitlabItems, gitlabView])

  const [taskSearchInput, setTaskSearchInput] = useState(initialTaskQuery)
  const [appliedTaskSearch, setAppliedTaskSearch] = useState(initialTaskQuery)
  const taskSearchInputRef = useRef<HTMLInputElement>(null)
  const [activeTaskPreset, setActiveTaskPreset] = useState<TaskViewPresetId | null>(
    defaultTaskViewPreset
  )
  const [tasksLoading, setTasksLoading] = useState(false)
  const [tasksRefreshing, setTasksRefreshing] = useState(false)
  const [tasksFiltering, setTasksFiltering] = useState(false)
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
  // Why: entering Tasks with fresh cache should still verify remote status
  // once, but the result is reconciled into existing rows to avoid a full
  // table shuffle when only status/key fields changed.
  const landingGitHubRefreshKeysRef = useRef<ReadonlySet<string>>(new Set())
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
  const githubTaskDrawerWorkItem = useAppStore((s) => s.githubTaskDrawerWorkItem)
  const setGithubTaskDrawerWorkItem = useAppStore((s) => s.setGithubTaskDrawerWorkItem)
  const [dialogInitialTab, setDialogInitialTab] = useState<ItemDialogTab>('conversation')
  const dialogWorkItemKey = githubTaskDrawerWorkItem
    ? { id: githubTaskDrawerWorkItem.id, repoId: githubTaskDrawerWorkItem.repoId }
    : null

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
  const dialogWorkItem = dialogWorkItemKey
    ? (cachedDialogWorkItem ?? githubTaskDrawerWorkItem)
    : null
  const dialogRepoPath = dialogWorkItem ? (repoMap.get(dialogWorkItem.repoId)?.path ?? null) : null

  const setDialogWorkItem = useCallback(
    (item: GitHubWorkItem | null, initialTab: ItemDialogTab = 'conversation') => {
      setDialogInitialTab(item ? initialTab : 'conversation')
      setGithubTaskDrawerWorkItem(item)
    },
    [setGithubTaskDrawerWorkItem]
  )

  useEffect(() => {
    if (!pageData.openGitHubWorkItem) {
      setDialogWorkItem(null)
      return
    }
    setGithubMode('items')
    setDialogWorkItem(pageData.openGitHubWorkItem, pageData.openGitHubInitialTab)
  }, [pageData.openGitHubInitialTab, pageData.openGitHubWorkItem, setDialogWorkItem])

  const openGitHubDetailPage = useCallback(
    (item: GitHubWorkItem, initialTab: ItemDialogTab = 'conversation') => {
      openTaskPage({
        taskSource: 'github',
        preselectedRepoId: item.repoId,
        openGitHubWorkItem: item,
        openGitHubInitialTab: initialTab
      })
    },
    [openTaskPage]
  )

  const patchTaskPageWorkItemRows = useCallback(
    (
      itemKey: { id: string; repoId: string },
      patch: Partial<GitHubWorkItem>,
      shouldPatch?: (item: GitHubWorkItem) => boolean
    ): void => {
      setPages((current) => {
        let changed = false
        const nextPages = current.map((page) => {
          let pageChanged = false
          const nextPage = page.map((item) => {
            if (item.id !== itemKey.id || item.repoId !== itemKey.repoId) {
              return item
            }
            if (shouldPatch && !shouldPatch(item)) {
              return item
            }
            pageChanged = true
            changed = true
            return { ...item, ...patch }
          })
          return pageChanged ? nextPage : page
        })
        return changed ? nextPages : current
      })
    },
    []
  )
  const handleDialogReviewRequestsChange = useCallback(
    (itemKey: { id: string; repoId: string }, reviewRequests: GitHubAssignableUser[]): void => {
      patchTaskPageWorkItemRows(itemKey, { reviewRequests })
    },
    [patchTaskPageWorkItemRows]
  )

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

  useEffect(() => {
    if (taskSource !== 'github' || githubMode !== 'items') {
      return
    }
    // Why: inline/dialog edits patch `workItemsCache`; the paged table renders
    // from a local snapshot so it needs the patched row objects copied across.
    setPages((current) =>
      reconcileTaskPagePagesWithWorkItemsCache(current, selectedWorkItemsCacheEntries)
    )
  }, [githubMode, selectedWorkItemsCacheEntries, taskSource])

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
  const handleRefreshGithubTasks = useCallback((): void => {
    setTasksRefreshing(true)
    setTaskRefreshNonce((current) => current + 1)
  }, [])
  const [newIssueOpen, setNewIssueOpen] = useState(false)
  const [newIssueTitle, setNewIssueTitle] = useState('')
  const [newIssueBody, setNewIssueBody] = useState('')
  const [newIssueLabels, setNewIssueLabels] = useState<string[]>([])
  const [newIssueAssignees, setNewIssueAssignees] = useState<GitHubAssignableUser[]>([])
  const [newIssueSubmitting, setNewIssueSubmitting] = useState(false)
  const [newIssueRepoId, setNewIssueRepoId] = useState<string | null>(null)

  // Why: resolve the target repo from the user's choice, falling back to the
  // first selected repo if the chosen id drops out of the selection while the
  // dialog is open — keeps submit always landing on a valid repo.
  const newIssueTargetRepo = useMemo(
    () => selectedRepos.find((r) => r.id === newIssueRepoId) ?? selectedRepos[0] ?? null,
    [selectedRepos, newIssueRepoId]
  )
  const newIssueRuntimeTarget = useMemo(() => {
    if (!newIssueTargetRepo?.id) {
      return null
    }
    const target = getActiveRuntimeTarget(settings)
    if (target.kind !== 'environment') {
      return null
    }
    return repos.some((repo) => repo.id === newIssueTargetRepo.id) ? target : null
  }, [newIssueTargetRepo?.id, repos, settings])
  const newIssueRepoLabels = useRepoLabels(
    newIssueOpen ? (newIssueTargetRepo?.path ?? null) : null,
    newIssueOpen ? (newIssueTargetRepo?.id ?? null) : null,
    { runtimeEnvironmentId: newIssueOpen ? (newIssueRuntimeTarget?.environmentId ?? null) : null }
  )
  const newIssueRepoAssignees = useRepoAssignees(
    newIssueOpen ? (newIssueTargetRepo?.path ?? null) : null,
    newIssueOpen ? (newIssueTargetRepo?.id ?? null) : null,
    { runtimeEnvironmentId: newIssueOpen ? (newIssueRuntimeTarget?.environmentId ?? null) : null }
  )

  useEffect(() => {
    setNewIssueLabels([])
    setNewIssueAssignees([])
  }, [newIssueTargetRepo?.id])

  const [selectedLinearIssueId, setSelectedLinearIssueId] = useState<string | null>(null)
  const [selectedLinearIssueFallback, setSelectedLinearIssueFallback] =
    useState<LinearIssue | null>(null)
  const [selectedLinearIssueCanFloat, setSelectedLinearIssueCanFloat] = useState(false)

  // Why: the Linear list keeps its own fetched array, while cell edits patch
  // the shared caches. Subscribing to just the Linear caches lets the list and
  // inline detail reflect optimistic mutations without a second durable cache.
  const linearCacheSnapshot = useAppStore(
    useShallow((s) => ({
      issueCache: s.linearIssueCache,
      searchCache: s.linearSearchCache,
      listCache: s.linearListCache
    }))
  )
  const cachedSelectedLinearIssue = findTaskPageLinearIssue(
    linearCacheSnapshot.issueCache,
    linearCacheSnapshot.searchCache,
    linearCacheSnapshot.listCache,
    selectedLinearIssueId
  )
  const selectedLinearIssue = selectedLinearIssueId
    ? (cachedSelectedLinearIssue ?? selectedLinearIssueFallback)
    : null

  const setSelectedLinearIssue = useCallback(
    (issue: LinearIssue | null, options?: { allowOutsideList?: boolean }) => {
      setSelectedLinearIssueCanFloat(Boolean(issue && options?.allowOutsideList))
      setSelectedLinearIssueId(issue?.id ?? null)
      setSelectedLinearIssueFallback(issue)
    },
    []
  )

  const clearSelectedLinearIssue = useCallback(() => {
    setSelectedLinearIssueCanFloat(false)
    setSelectedLinearIssueId(null)
    setSelectedLinearIssueFallback(null)
  }, [])

  useEffect(() => {
    if (!pageData.openLinearIssue) {
      clearSelectedLinearIssue()
      return
    }
    setSelectedLinearIssue(pageData.openLinearIssue, { allowOutsideList: true })
  }, [clearSelectedLinearIssue, pageData.openLinearIssue, setSelectedLinearIssue])

  const openLinearDetailPage = useCallback(
    (issue: LinearIssue) => {
      openTaskPage({ taskSource: 'linear', openLinearIssue: issue })
    },
    [openTaskPage]
  )

  const openRelatedLinearIssue = useCallback(
    (issue: LinearIssue) => {
      openLinearDetailPage(issue)
    },
    [openLinearDetailPage]
  )

  const closeTaskDetailPage = useCallback(() => {
    const state = useAppStore.getState()
    const currentEntry = state.worktreeNavHistory[state.worktreeNavHistoryIndex]
    if (
      typeof currentEntry === 'object' &&
      currentEntry.kind === 'task-detail' &&
      state.worktreeNavHistoryIndex > 0
    ) {
      state.goBackWorktree()
      return
    }
    setDialogWorkItem(null)
    clearSelectedLinearIssue()
    useAppStore.setState((s) => ({
      taskPageData: {
        ...s.taskPageData,
        openGitHubWorkItem: undefined,
        openGitHubInitialTab: undefined,
        openLinearIssue: undefined
      }
    }))
  }, [clearSelectedLinearIssue, setDialogWorkItem])

  const [selectedJiraIssueKey, setSelectedJiraIssueKey] = useState<string | null>(null)
  const [selectedJiraIssueFallback, setSelectedJiraIssueFallback] = useState<JiraIssue | null>(null)
  const jiraCacheSnapshot = useAppStore(
    useShallow((s) => ({
      issueCache: s.jiraIssueCache,
      searchCache: s.jiraSearchCache
    }))
  )
  const cachedSelectedJiraIssue = findTaskPageJiraIssue(
    jiraCacheSnapshot.issueCache,
    jiraCacheSnapshot.searchCache,
    selectedJiraIssueKey
  )
  const selectedJiraIssue = selectedJiraIssueKey
    ? (cachedSelectedJiraIssue ?? selectedJiraIssueFallback)
    : null

  const setSelectedJiraIssue = useCallback((issue: JiraIssue | null) => {
    setSelectedJiraIssueKey(issue?.key ?? null)
    setSelectedJiraIssueFallback(issue)
  }, [])

  // Linear tab state
  const [linearMode, setLinearMode] = useState<LinearMode>('issues')
  const [linearIssues, setLinearIssues] = useState<LinearIssue[]>([])
  const [linearIssueLimit, setLinearIssueLimit] = useState(LINEAR_ITEM_LIMIT)
  const [linearIssuePage, setLinearIssuePage] = useState(0)
  const [linearIssueLoadingTargetPage, setLinearIssueLoadingTargetPage] = useState<number | null>(
    null
  )
  const [linearIssuesHasMore, setLinearIssuesHasMore] = useState(false)
  const [linearLoading, setLinearLoading] = useState(false)
  const [linearError, setLinearError] = useState<string | null>(null)
  const [linearSearchInput, setLinearSearchInput] = useState('')
  const [appliedLinearSearch, setAppliedLinearSearch] = useState('')
  const [linearViewMode, setLinearViewMode] = useState<LinearViewMode>('list')
  const [linearGroupBy, setLinearGroupBy] = useState<LinearGroupBy>('none')
  const [linearOrderBy, setLinearOrderBy] = useState<LinearOrderBy>('priority')
  const [linearDisplayProperties, setLinearDisplayProperties] = useState<
    ReadonlySet<LinearDisplayProperty>
  >(() => new Set(DEFAULT_LINEAR_DISPLAY_PROPERTIES))
  const [linearTeamPropertyTouched, setLinearTeamPropertyTouched] = useState(false)
  const [linearRefreshNonce, setLinearRefreshNonce] = useState(0)
  const [linearProjectSearchInput, setLinearProjectSearchInput] = useState('')
  const [appliedLinearProjectSearch, setAppliedLinearProjectSearch] = useState('')
  const [linearProjectsResult, setLinearProjectsResult] = useState<
    LinearCollectionResult<LinearProjectSummary>
  >({ items: [] })
  const [linearProjectsLoading, setLinearProjectsLoading] = useState(false)
  const [linearProjectsError, setLinearProjectsError] = useState<string | null>(null)
  const [selectedLinearProject, setSelectedLinearProject] = useState<LinearProjectSummary | null>(
    null
  )
  const [selectedLinearProjectDetail, setSelectedLinearProjectDetail] =
    useState<LinearProjectDetail | null>(null)
  const [linearProjectDetailLoading, setLinearProjectDetailLoading] = useState(false)
  const [linearProjectDetailError, setLinearProjectDetailError] = useState<string | null>(null)
  const [linearProjectTab, setLinearProjectTab] = useState<LinearProjectTab>('overview')
  const [linearProjectIssuesResult, setLinearProjectIssuesResult] = useState<
    LinearCollectionResult<LinearIssue>
  >({ items: [] })
  const [linearProjectIssueLimit, setLinearProjectIssueLimit] = useState(LINEAR_ITEM_LIMIT)
  const [linearProjectIssuePage, setLinearProjectIssuePage] = useState(0)
  const [linearProjectIssueLoadingTargetPage, setLinearProjectIssueLoadingTargetPage] = useState<
    number | null
  >(null)
  const [linearProjectIssuesLoading, setLinearProjectIssuesLoading] = useState(false)
  const [linearProjectIssuesError, setLinearProjectIssuesError] = useState<string | null>(null)
  const [linearCustomViewModel, setLinearCustomViewModel] = useState<LinearCustomViewModel>('issue')
  const [linearCustomViewsResult, setLinearCustomViewsResult] = useState<
    LinearCollectionResult<LinearCustomViewSummary>
  >({ items: [] })
  const [linearCustomViewsLoading, setLinearCustomViewsLoading] = useState(false)
  const [linearCustomViewsError, setLinearCustomViewsError] = useState<string | null>(null)
  const [selectedLinearCustomView, setSelectedLinearCustomView] =
    useState<LinearCustomViewSummary | null>(null)
  const [linearProjectParentView, setLinearProjectParentView] =
    useState<LinearCustomViewSummary | null>(null)
  const [linearCustomViewIssuesResult, setLinearCustomViewIssuesResult] = useState<
    LinearCollectionResult<LinearIssue>
  >({ items: [] })
  const [linearCustomViewIssueLimit, setLinearCustomViewIssueLimit] = useState(LINEAR_ITEM_LIMIT)
  const [linearCustomViewIssuePage, setLinearCustomViewIssuePage] = useState(0)
  const [linearCustomViewIssueLoadingTargetPage, setLinearCustomViewIssueLoadingTargetPage] =
    useState<number | null>(null)
  const [linearCustomViewProjectsResult, setLinearCustomViewProjectsResult] = useState<
    LinearCollectionResult<LinearProjectSummary>
  >({ items: [] })
  const [linearCustomViewContentsLoading, setLinearCustomViewContentsLoading] = useState(false)
  const [linearCustomViewContentsError, setLinearCustomViewContentsError] = useState<string | null>(
    null
  )
  const [linearBoardDraggingIssueId, setLinearBoardDraggingIssueId] = useState<string | null>(null)
  const [linearBoardDragOverKey, setLinearBoardDragOverKey] = useState<string | null>(null)
  const [linearBoardUpdatingIssueIds, setLinearBoardUpdatingIssueIds] = useState<
    ReadonlySet<string>
  >(() => new Set())
  const lastLinearRequestRef = useRef<{ nonce: number; signature: string } | null>(null)
  const landingLinearRefreshKeysRef = useRef<ReadonlySet<string>>(new Set())
  const linearContextResumeAttemptedRef = useRef(false)

  const patchScopedLinearIssue = useCallback((issueId: string, patch: Partial<LinearIssue>) => {
    const patchResult = (result: LinearCollectionResult<LinearIssue>) => ({
      ...result,
      items: result.items.map((item) => (item.id === issueId ? { ...item, ...patch } : item))
    })
    setLinearProjectIssuesResult(patchResult)
    setLinearCustomViewIssuesResult(patchResult)
  }, [])

  const selectLinearMode = useCallback(
    (mode: LinearMode) => {
      clearSelectedLinearIssue()
      setSelectedLinearProject(null)
      setSelectedLinearProjectDetail(null)
      setSelectedLinearCustomView(null)
      setLinearProjectParentView(null)
      setLinearProjectIssuesResult({ items: [] })
      setLinearProjectIssueLimit(LINEAR_ITEM_LIMIT)
      setLinearProjectIssuePage(0)
      setLinearProjectIssueLoadingTargetPage(null)
      setLinearCustomViewIssuesResult({ items: [] })
      setLinearCustomViewIssueLimit(LINEAR_ITEM_LIMIT)
      setLinearCustomViewIssuePage(0)
      setLinearCustomViewIssueLoadingTargetPage(null)
      setLinearCustomViewProjectsResult({ items: [] })
      setLinearMode(mode)
      setTaskResumeState({ linearMode: mode, linearContext: undefined })
    },
    [clearSelectedLinearIssue, setTaskResumeState]
  )

  const openLinearProjectContext = useCallback(
    (project: LinearProjectSummary, options?: { parentView?: LinearCustomViewSummary | null }) => {
      if (!project.workspaceId) {
        toast.error('Linear project is missing workspace context.')
        return
      }
      const parentView = options?.parentView ?? null
      clearSelectedLinearIssue()
      setLinearProjectParentView(parentView)
      if (parentView) {
        setSelectedLinearCustomView(parentView)
      } else {
        setSelectedLinearCustomView(null)
        setLinearCustomViewProjectsResult({ items: [] })
      }
      setLinearProjectIssuesResult({ items: [] })
      setLinearProjectIssueLimit(LINEAR_ITEM_LIMIT)
      setLinearProjectIssuePage(0)
      setLinearProjectIssueLoadingTargetPage(null)
      setLinearCustomViewIssuesResult({ items: [] })
      setLinearCustomViewIssueLimit(LINEAR_ITEM_LIMIT)
      setLinearCustomViewIssuePage(0)
      setLinearCustomViewIssueLoadingTargetPage(null)
      setSelectedLinearProject(project)
      setLinearProjectTab('overview')
      setLinearMode('projects')
      setTaskResumeState({
        linearMode: 'projects',
        linearContext: { kind: 'project', id: project.id, workspaceId: project.workspaceId }
      })
    },
    [clearSelectedLinearIssue, setTaskResumeState]
  )

  const openLinearCustomViewContext = useCallback(
    (view: LinearCustomViewSummary) => {
      if (!view.workspaceId) {
        toast.error('Linear view is missing workspace context.')
        return
      }
      clearSelectedLinearIssue()
      setSelectedLinearProject(null)
      setSelectedLinearProjectDetail(null)
      setLinearProjectParentView(null)
      setLinearProjectIssuesResult({ items: [] })
      setLinearProjectIssueLimit(LINEAR_ITEM_LIMIT)
      setLinearProjectIssuePage(0)
      setLinearProjectIssueLoadingTargetPage(null)
      setLinearCustomViewIssuesResult({ items: [] })
      setLinearCustomViewIssueLimit(LINEAR_ITEM_LIMIT)
      setLinearCustomViewIssuePage(0)
      setLinearCustomViewIssueLoadingTargetPage(null)
      setLinearCustomViewProjectsResult({ items: [] })
      setSelectedLinearCustomView(view)
      setLinearMode('views')
      setTaskResumeState({
        linearMode: 'views',
        linearContext: {
          kind: 'view',
          id: view.id,
          workspaceId: view.workspaceId,
          model: view.model
        }
      })
    },
    [clearSelectedLinearIssue, setTaskResumeState]
  )

  // Jira tab state
  const [jiraIssues, setJiraIssues] = useState<JiraIssue[]>([])
  const [jiraLoading, setJiraLoading] = useState(false)
  const [jiraError, setJiraError] = useState<string | null>(null)
  const [jiraSearchInput, setJiraSearchInput] = useState('')
  const [appliedJiraSearch, setAppliedJiraSearch] = useState('')
  const [activeJiraPreset, setActiveJiraPreset] = useState<JiraPresetId>('assigned')
  const [jiraRefreshNonce, setJiraRefreshNonce] = useState(0)

  useEffect(() => {
    if (taskResumeAppliedRef.current || !persistedUIReady || !settings) {
      return
    }

    setTaskSource(
      resolveVisibleTaskProvider(
        pageData.taskSource ?? settings.defaultTaskSource,
        visibleTaskProviders
      )
    )
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
      const presetId = normalizeGitHubTaskPreset(preset ?? settings.defaultTaskViewPreset)
      const query = getTaskPresetQuery(presetId)
      setTaskSearchInput(query)
      setAppliedTaskSearch(query)
      setActiveTaskPreset(presetId)
    }

    const linearQuery = taskResumeState?.linearQuery ?? ''
    setLinearMode(taskResumeState?.linearMode ?? 'issues')
    setLinearSearchInput(linearQuery)
    setAppliedLinearSearch(linearQuery)

    const jiraPreset = taskResumeState?.jiraPreset ?? 'assigned'
    const jiraQuery = taskResumeState?.jiraQuery ?? ''
    setActiveJiraPreset(jiraPreset)
    setJiraSearchInput(jiraQuery)
    setAppliedJiraSearch(jiraQuery)

    // Why: settings and persisted UI hydrate asynchronously. Apply the restored
    // Tasks context exactly once so later source/filter clicks remain local.
    taskResumeAppliedRef.current = true
    setTaskResumeApplied(true)
  }, [
    persistedUIReady,
    settings,
    pageData.taskSource,
    resolvedInitialSelection,
    taskResumeState,
    visibleTaskProviders
  ])

  useEffect(() => {
    const context = taskResumeState?.linearContext
    if (
      linearContextResumeAttemptedRef.current ||
      !taskResumeApplied ||
      taskSource !== 'linear' ||
      !linearStatus.connected ||
      !context
    ) {
      return
    }
    linearContextResumeAttemptedRef.current = true
    let cancelled = false

    if (context.kind === 'project') {
      void fetchLinearProject(context.id, context.workspaceId, { force: true })
        .then((project) => {
          if (cancelled) {
            return
          }
          if (!project) {
            setSelectedLinearProject(null)
            setSelectedLinearProjectDetail(null)
            setLinearProjectParentView(null)
            setLinearProjectsError('Saved Linear project was not found.')
            setTaskResumeState({ linearContext: undefined })
            return
          }
          setSelectedLinearProject(project)
          setSelectedLinearProjectDetail(project)
          setLinearMode('projects')
        })
        .catch(() => {
          if (!cancelled) {
            setSelectedLinearProject(null)
            setSelectedLinearProjectDetail(null)
            setLinearProjectParentView(null)
            setLinearProjectsError('Failed to restore saved Linear project.')
            setTaskResumeState({ linearContext: undefined })
          }
        })
      return () => {
        cancelled = true
      }
    }

    if (context.kind === 'view' && context.model) {
      setLinearCustomViewModel(context.model)
      setLinearMode('views')
      setLinearCustomViewsLoading(true)
      setLinearCustomViewsError(null)
      void fetchLinearCustomView(context.id, context.workspaceId, context.model, {
        force: true
      })
        .then((restoredView) => {
          if (cancelled) {
            return
          }
          setLinearCustomViewsLoading(false)
          if (!restoredView) {
            setSelectedLinearCustomView(null)
            setLinearCustomViewsError('Saved Linear view was not found.')
            setTaskResumeState({ linearContext: undefined })
            return
          }
          setSelectedLinearCustomView(restoredView)
        })
        .catch(() => {
          if (!cancelled) {
            setSelectedLinearCustomView(null)
            setLinearCustomViewsLoading(false)
            setLinearCustomViewsError('Failed to restore saved Linear view.')
            setTaskResumeState({ linearContext: undefined })
          }
        })
      return () => {
        cancelled = true
      }
    }
    return undefined
  }, [
    fetchLinearCustomView,
    fetchLinearProject,
    listLinearCustomViews,
    linearStatus.connected,
    setTaskResumeState,
    taskResumeApplied,
    taskResumeState?.linearContext,
    taskSource
  ])

  // Why: fetch the full team list from the Linear API so the selector shows
  // all teams the user belongs to, not just teams with issues in the current
  // fetch window. Fetched once when the Linear tab is active and connected.
  const [availableTeams, setAvailableTeams] = useState<LinearTeam[]>([])
  const [linearTeamRefreshNonce, setLinearTeamRefreshNonce] = useState(0)

  useEffect(() => {
    if (!taskResumeApplied) {
      return
    }
    if (taskSource !== 'linear' || !linearStatus.connected) {
      setAvailableTeams([])
      return
    }
    let cancelled = false
    const cachedTeams = getCachedLinearTeams(selectedLinearWorkspaceId)
    // Why: workspace switches must not leave the prior workspace's teams
    // available for new-issue creation while the replacement fetch is pending,
    // but a workspace-scoped cache can keep the selector usable immediately.
    setAvailableTeams(cachedTeams ?? [])
    void listLinearTeams(selectedLinearWorkspaceId)
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
  }, [
    taskSource,
    linearStatus.connected,
    selectedLinearWorkspaceId,
    linearTeamRefreshNonce,
    taskResumeApplied,
    getCachedLinearTeams,
    listLinearTeams
  ])

  const [availableJiraProjects, setAvailableJiraProjects] = useState<JiraProject[]>([])
  const [jiraProjectsLoading, setJiraProjectsLoading] = useState(false)

  useEffect(() => {
    if (!taskResumeApplied) {
      return
    }
    if (taskSource !== 'jira' || !jiraStatus.connected) {
      setAvailableJiraProjects([])
      setJiraProjectsLoading(false)
      return
    }
    let cancelled = false
    setAvailableJiraProjects([])
    setJiraProjectsLoading(true)
    void jiraListProjects(settings, selectedJiraSiteId)
      .then((projects) => {
        if (!cancelled) {
          setAvailableJiraProjects(projects)
        }
      })
      .catch(() => {
        if (!cancelled) {
          console.warn('[TaskPage] Failed to fetch Jira projects')
        }
      })
      .finally(() => {
        if (!cancelled) {
          setJiraProjectsLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [settings, taskSource, jiraStatus.connected, selectedJiraSiteId, taskResumeApplied])

  // Why: stable key for `selectedRepos` so the GitLab fetch effect below
  // doesn't re-run on every parent re-render just because the array
  // reference changed. The memoized string keys off id + path +
  // connectionId — the only fields the effect actually reads.
  const selectedReposKey = useMemo(
    () => selectedRepos.map((r) => `${r.id}|${r.path}|${r.connectionId ?? ''}`).join(','),
    [selectedRepos]
  )

  // Why: GitLab task-source data fetch. Issues and MRs are fetched
  // separately (mirrors GitHub's separate Issues / PRs endpoints) so
  // errors are isolated per tab and the backend doesn't need a combined
  // merge+sort that can hide failures.
  useEffect(() => {
    if (taskSource !== 'gitlab') {
      return
    }
    if (gitlabView === 'todos') {
      return
    }
    const activeIssueFilter =
      gitlabView === 'issues' && isGitLabIssueFilter(activeGitlabFilter) ? activeGitlabFilter : null
    const activeMRFilter =
      gitlabView === 'mrs' && isGitLabMRFilter(activeGitlabFilter) ? activeGitlabFilter : null
    if (
      (gitlabView === 'issues' && !activeIssueFilter) ||
      (gitlabView === 'mrs' && !activeMRFilter)
    ) {
      return
    }
    // Why: folder-mode repos have no remotes to derive a GitLab project from;
    // SSH-backed Git repos go through the same provider-aware IPC path.
    const eligibleRepos = selectedRepos
    if (eligibleRepos.length === 0) {
      setGitlabItems([])
      setGitlabLoading(false)
      setGitlabError(null)
      return
    }
    let stale = false
    setGitlabLoading(true)
    setGitlabError(null)

    const fetchItems =
      gitlabView === 'issues'
        ? (repo: (typeof eligibleRepos)[0]) => {
            const isAssignedToMe = activeIssueFilter === 'assigned-to-me'
            return window.api.gl
              .listIssues({
                repoPath: repo.path,
                state: 'opened',
                assignee: isAssignedToMe ? '@me' : undefined,
                limit: 50
              })
              .then((result) => {
                const typed = result as {
                  items: GitLabWorkItem[]
                  error?: { type?: string; message: string }
                }
                // Why: not_found just means "this repo isn't a GitLab project"
                // (e.g. a GitHub-only repo in a mixed selection). Drop it
                // silently so the GitLab list doesn't show false errors.
                const error = typed.error?.type === 'not_found' ? undefined : typed.error
                return { repoId: repo.id, items: typed.items, error }
              })
          }
        : (repo: (typeof eligibleRepos)[0]) =>
            window.api.gl
              .listMRs({
                repoPath: repo.path,
                state: activeMRFilter ?? 'opened',
                page: 1,
                perPage: 50
              })
              .then((result) => {
                const typed = result as {
                  items: GitLabWorkItem[]
                  error?: { type?: string; message: string }
                }
                const error = typed.error?.type === 'not_found' ? undefined : typed.error
                return { repoId: repo.id, items: typed.items, error }
              })

    void Promise.allSettled(eligibleRepos.map(fetchItems))
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
        // Why: only surface an error banner when EVERY eligible repo failed.
        // Mixed selections often include non-GitLab repos, and a partial
        // banner would hide the working rows.
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
  }, [taskSource, gitlabView, activeGitlabFilter, gitlabRefreshNonce, selectedReposKey])

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

  const activeLinearIssues =
    selectedLinearProject && linearProjectTab === 'issues'
      ? linearProjectIssuesResult.items
      : selectedLinearCustomView?.model === 'issue'
        ? linearCustomViewIssuesResult.items
        : linearIssues
  const activeLinearIssueLoading =
    selectedLinearProject && linearProjectTab === 'issues'
      ? linearProjectIssuesLoading
      : selectedLinearCustomView?.model === 'issue'
        ? linearCustomViewContentsLoading
        : linearLoading
  const activeLinearIssueError =
    selectedLinearProject && linearProjectTab === 'issues'
      ? linearProjectIssuesError
      : selectedLinearCustomView?.model === 'issue'
        ? linearCustomViewContentsError
        : linearError
  const activeLinearIssueCollectionErrors =
    selectedLinearProject && linearProjectTab === 'issues'
      ? linearProjectIssuesResult.errors
      : selectedLinearCustomView?.model === 'issue'
        ? linearCustomViewIssuesResult.errors
        : undefined
  const activeLinearIssueHasCollectionError = (activeLinearIssueCollectionErrors?.length ?? 0) > 0
  const activeLinearIssueContextLabel = selectedLinearProject
    ? `Project: ${selectedLinearProject.name}`
    : selectedLinearCustomView?.model === 'issue'
      ? `View: ${selectedLinearCustomView.name}`
      : null
  const canLoadMorePlainLinearIssues =
    !activeLinearIssueContextLabel &&
    appliedLinearSearch.trim().length === 0 &&
    linearIssuesHasMore &&
    linearIssueLimit < LINEAR_ISSUE_LIST_MAX
  const canLoadMoreLinearProjectIssues =
    selectedLinearProject !== null &&
    linearProjectTab === 'issues' &&
    Boolean(linearProjectIssuesResult.hasMore) &&
    linearProjectIssueLimit < LINEAR_ISSUE_LIST_MAX
  const canLoadMoreLinearCustomViewIssues =
    selectedLinearCustomView?.model === 'issue' &&
    Boolean(linearCustomViewIssuesResult.hasMore) &&
    linearCustomViewIssueLimit < LINEAR_ISSUE_LIST_MAX
  const activeLinearIssuePage =
    selectedLinearProject && linearProjectTab === 'issues'
      ? linearProjectIssuePage
      : selectedLinearCustomView?.model === 'issue'
        ? linearCustomViewIssuePage
        : linearIssuePage
  const activeLinearIssueLoadingTargetPage =
    selectedLinearProject && linearProjectTab === 'issues'
      ? linearProjectIssueLoadingTargetPage
      : selectedLinearCustomView?.model === 'issue'
        ? linearCustomViewIssueLoadingTargetPage
        : linearIssueLoadingTargetPage
  const activeLinearIssueCanLoadMore =
    selectedLinearProject && linearProjectTab === 'issues'
      ? canLoadMoreLinearProjectIssues
      : selectedLinearCustomView?.model === 'issue'
        ? canLoadMoreLinearCustomViewIssues
        : canLoadMorePlainLinearIssues
  const activeLinearIssueCanRequestMore =
    activeLinearIssueCanLoadMore && !activeLinearIssueHasCollectionError
  const activeLinearIssueLimit =
    selectedLinearProject && linearProjectTab === 'issues'
      ? linearProjectIssueLimit
      : selectedLinearCustomView?.model === 'issue'
        ? linearCustomViewIssueLimit
        : linearIssueLimit

  const displayedLinearIssues = useMemo(
    () =>
      activeLinearIssues.map(
        (issue) =>
          findTaskPageLinearIssue(
            linearCacheSnapshot.issueCache,
            linearCacheSnapshot.searchCache,
            linearCacheSnapshot.listCache,
            issue.id
          ) ?? issue
      ),
    [
      activeLinearIssues,
      linearCacheSnapshot.issueCache,
      linearCacheSnapshot.listCache,
      linearCacheSnapshot.searchCache
    ]
  )

  const linearIssueTeams = useMemo(() => {
    const seen = new Set<string>()
    const teams: LinearTeam[] = []
    for (const issue of displayedLinearIssues) {
      if (!issue.team.id || seen.has(issue.team.id)) {
        continue
      }
      seen.add(issue.team.id)
      teams.push({
        id: issue.team.id,
        workspaceId: issue.workspaceId,
        workspaceName: issue.workspaceName,
        name: issue.team.name,
        key: issue.team.key,
        url:
          buildLinearTeamUrl({
            organizationUrlKey: getLinearOrganizationUrlKeyFromIssueUrl(issue.url),
            teamKey: issue.team.key
          }) ?? undefined
      })
    }
    return teams.sort((a, b) => a.name.localeCompare(b.name))
  }, [displayedLinearIssues])

  // Why: the full Linear team fetch is async and can temporarily be empty.
  // Keep the selector usable from issue metadata until the complete list lands.
  const linearTeamOptions = useMemo(() => {
    if (availableTeams.length === 0) {
      return linearIssueTeams
    }
    const issueTeamById = new Map(linearIssueTeams.map((team) => [team.id, team]))
    return availableTeams.map((team) => {
      if (team.url) {
        return team
      }
      return {
        ...team,
        url: issueTeamById.get(team.id)?.url
      }
    })
  }, [availableTeams, linearIssueTeams])

  // Why: team IDs belong to one Linear workspace. Switching workspaces while a
  // saved subset exists must not leave the task list filtered by stale team IDs.
  useEffect(() => {
    if (linearTeamOptions.length === 0) {
      return
    }
    setLinearTeamSelection(
      reconcileLinearTeamSelection(linearTeamOptions, defaultLinearTeamSelection)
    )
  }, [linearTeamOptions, defaultLinearTeamSelection])

  const filteredLinearIssues = useMemo(() => {
    if (activeLinearIssueContextLabel) {
      return displayedLinearIssues
    }
    // Why: team options can be derived after issue rows render. Treat an
    // empty selection as "all" until reconciliation has a concrete team set.
    if (displayedLinearIssues.length > 0 && linearTeamSelection.size === 0) {
      return displayedLinearIssues
    }
    return displayedLinearIssues.filter((issue) => linearTeamSelection.has(issue.team.id))
  }, [activeLinearIssueContextLabel, displayedLinearIssues, linearTeamSelection])

  const orderedLinearIssues = useMemo(
    () => [...filteredLinearIssues].sort((a, b) => compareLinearIssues(a, b, linearOrderBy)),
    [filteredLinearIssues, linearOrderBy]
  )
  const loadedLinearIssuePages = Math.max(
    1,
    Math.ceil(orderedLinearIssues.length / LINEAR_ITEM_LIMIT)
  )
  const linearIssueTotalPages =
    orderedLinearIssues.length === 0
      ? 1
      : loadedLinearIssuePages + (activeLinearIssueCanRequestMore ? 1 : 0)
  const visibleLinearIssuePage = Math.min(
    activeLinearIssuePage,
    Math.max(0, loadedLinearIssuePages - 1)
  )
  const pagedLinearIssues = useMemo(() => {
    const start = visibleLinearIssuePage * LINEAR_ITEM_LIMIT
    return orderedLinearIssues.slice(start, start + LINEAR_ITEM_LIMIT)
  }, [orderedLinearIssues, visibleLinearIssuePage])
  const showLinearIssuePagination =
    orderedLinearIssues.length > 0 &&
    !activeLinearIssueError &&
    linearIssueTotalPages > 1 &&
    !(activeLinearIssueLoading && activeLinearIssues.length === 0)

  const setActiveLinearIssuePage = useCallback(
    (page: number) => {
      if (selectedLinearProject && linearProjectTab === 'issues') {
        setLinearProjectIssuePage(page)
      } else if (selectedLinearCustomView?.model === 'issue') {
        setLinearCustomViewIssuePage(page)
      } else {
        setLinearIssuePage(page)
      }
    },
    [linearProjectTab, selectedLinearCustomView?.model, selectedLinearProject]
  )

  const setActiveLinearIssueLoadingTargetPage = useCallback(
    (page: number | null) => {
      if (selectedLinearProject && linearProjectTab === 'issues') {
        setLinearProjectIssueLoadingTargetPage(page)
      } else if (selectedLinearCustomView?.model === 'issue') {
        setLinearCustomViewIssueLoadingTargetPage(page)
      } else {
        setLinearIssueLoadingTargetPage(page)
      }
    },
    [linearProjectTab, selectedLinearCustomView?.model, selectedLinearProject]
  )

  const ensureActiveLinearIssueLimit = useCallback(
    (targetLimit: number) => {
      const nextLimit = Math.min(clampLinearIssueListLimit(targetLimit), LINEAR_ISSUE_LIST_MAX)
      if (selectedLinearProject && linearProjectTab === 'issues') {
        setLinearProjectIssueLimit((limit) => Math.max(limit, nextLimit))
      } else if (selectedLinearCustomView?.model === 'issue') {
        setLinearCustomViewIssueLimit((limit) => Math.max(limit, nextLimit))
      } else {
        setLinearIssueLimit((limit) => Math.max(limit, nextLimit))
      }
    },
    [linearProjectTab, selectedLinearCustomView?.model, selectedLinearProject]
  )

  const handleLinearIssuePageChange = useCallback(
    (page: number) => {
      if (page < loadedLinearIssuePages) {
        setActiveLinearIssuePage(page)
        setActiveLinearIssueLoadingTargetPage(null)
        return
      }

      // Why: unlike GitHub's cursor pages, Linear reads are cached as an
      // expanded prefix. Jumping to a new page first expands the prefix, then
      // commits the page when the fetch returns enough rows.
      setActiveLinearIssueLoadingTargetPage(page)
      ensureActiveLinearIssueLimit((page + 1) * LINEAR_ITEM_LIMIT)
    },
    [
      ensureActiveLinearIssueLimit,
      loadedLinearIssuePages,
      setActiveLinearIssueLoadingTargetPage,
      setActiveLinearIssuePage
    ]
  )

  const showLinearEmptyFilteredLoadMore =
    orderedLinearIssues.length === 0 && !activeLinearIssueError && activeLinearIssueCanRequestMore
  const handleLinearEmptyFilteredLoadMore = useCallback(() => {
    setActiveLinearIssueLoadingTargetPage(null)
    ensureActiveLinearIssueLimit(activeLinearIssueLimit + LINEAR_ITEM_LIMIT)
  }, [activeLinearIssueLimit, ensureActiveLinearIssueLimit, setActiveLinearIssueLoadingTargetPage])

  useEffect(() => {
    if (activeLinearIssueLoading || activeLinearIssueLoadingTargetPage === null) {
      return
    }

    const maxLoadedPage = Math.max(0, loadedLinearIssuePages - 1)
    const targetPageLoaded = activeLinearIssueLoadingTargetPage <= maxLoadedPage
    const targetPageCannotLoad =
      !activeLinearIssueCanRequestMore || activeLinearIssueLimit >= LINEAR_ISSUE_LIST_MAX
    if (targetPageLoaded || targetPageCannotLoad) {
      setActiveLinearIssuePage(Math.min(activeLinearIssueLoadingTargetPage, maxLoadedPage))
      setActiveLinearIssueLoadingTargetPage(null)
      return
    }

    // Why: Linear can return more backend rows without immediately filling the
    // next visible page after local team filtering. Keep expanding the prefix
    // until the requested page exists or Linear reports exhaustion.
    ensureActiveLinearIssueLimit(activeLinearIssueLimit + LINEAR_ITEM_LIMIT)
  }, [
    activeLinearIssueCanRequestMore,
    activeLinearIssueHasCollectionError,
    activeLinearIssueLimit,
    activeLinearIssueLoading,
    activeLinearIssueLoadingTargetPage,
    ensureActiveLinearIssueLimit,
    loadedLinearIssuePages,
    setActiveLinearIssueLoadingTargetPage,
    setActiveLinearIssuePage
  ])

  useEffect(() => {
    if (
      activeLinearIssueLoadingTargetPage !== null ||
      activeLinearIssuePage <= visibleLinearIssuePage
    ) {
      return
    }
    setActiveLinearIssuePage(visibleLinearIssuePage)
  }, [
    activeLinearIssueLoadingTargetPage,
    activeLinearIssuePage,
    setActiveLinearIssuePage,
    visibleLinearIssuePage
  ])

  const selectedLinearTeamForExternalLink = useMemo(() => {
    if (linearTeamSelection.size !== 1) {
      return null
    }
    const [teamId] = linearTeamSelection
    return linearTeamOptions.find((team) => team.id === teamId && team.url) ?? null
  }, [linearTeamOptions, linearTeamSelection])

  const effectiveLinearDisplayProperties = useMemo(() => {
    const next = new Set(linearDisplayProperties)
    const groupedProperty =
      linearGroupBy === 'status'
        ? 'state'
        : linearGroupBy === 'assignee' || linearGroupBy === 'priority' || linearGroupBy === 'team'
          ? linearGroupBy
          : null
    if (groupedProperty) {
      next.delete(groupedProperty)
    }

    // Why: a Team column repeats the same value when one team is selected.
    // Keep it hidden until the user explicitly opts back into that property.
    if (linearTeamSelection.size <= 1 && !linearTeamPropertyTouched) {
      next.delete('team')
    } else if (linearTeamSelection.size > 1 && !linearTeamPropertyTouched) {
      next.add('team')
    }
    return next
  }, [linearDisplayProperties, linearGroupBy, linearTeamPropertyTouched, linearTeamSelection.size])
  const linearIssueGridTemplate = useMemo(
    () => getLinearIssueGridTemplate(effectiveLinearDisplayProperties),
    [effectiveLinearDisplayProperties]
  )
  const linearIssueGridStyle = useMemo(
    () =>
      ({
        '--linear-grid-template': linearIssueGridTemplate
      }) as React.CSSProperties,
    [linearIssueGridTemplate]
  )
  const linearIssueSections = useMemo(
    () => groupLinearIssues(pagedLinearIssues, linearGroupBy, linearOrderBy),
    [pagedLinearIssues, linearGroupBy, linearOrderBy]
  )
  const linearIssueListRows = useMemo<LinearIssueListRow[]>(
    () =>
      linearIssueSections.flatMap((section) => {
        const issueRows = section.issues.map((issue) => ({ type: 'issue' as const, issue }))
        if (linearGroupBy === 'none') {
          return issueRows
        }
        return [
          {
            type: 'section' as const,
            key: section.key,
            label: section.label,
            count: section.issues.length
          },
          ...issueRows
        ]
      }),
    [linearGroupBy, linearIssueSections]
  )
  const linearBoardSections = useMemo(
    () =>
      groupLinearIssues(
        pagedLinearIssues,
        linearGroupBy === 'none' ? 'status' : linearGroupBy,
        linearOrderBy
      ),
    [pagedLinearIssues, linearGroupBy, linearOrderBy]
  )
  const linearStatusBoardEnabled = linearGroupBy === 'none' || linearGroupBy === 'status'

  const handleLinearBoardCardDragStart = useCallback(
    (issue: LinearIssue, event: React.DragEvent<HTMLDivElement>) => {
      if (!linearStatusBoardEnabled || linearBoardUpdatingIssueIds.has(issue.id)) {
        event.preventDefault()
        return
      }
      event.dataTransfer.effectAllowed = 'move'
      event.dataTransfer.setData(LINEAR_BOARD_DRAG_ISSUE_MIME, issue.id)
      event.dataTransfer.setData('text/plain', issue.id)
      setLinearBoardDraggingIssueId(issue.id)
    },
    [linearBoardUpdatingIssueIds, linearStatusBoardEnabled]
  )

  const handleLinearBoardDragOver = useCallback(
    (section: LinearGroupSection, event: React.DragEvent<HTMLElement>) => {
      if (!linearStatusBoardEnabled || !getLinearStatusSectionState(section)) {
        return
      }
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      setLinearBoardDragOverKey(section.key)
    },
    [linearStatusBoardEnabled]
  )

  const handleLinearBoardDrop = useCallback(
    async (section: LinearGroupSection, event: React.DragEvent<HTMLElement>) => {
      event.preventDefault()
      event.stopPropagation()
      setLinearBoardDragOverKey(null)

      const targetState = getLinearStatusSectionState(section)
      if (!linearStatusBoardEnabled || !targetState) {
        return
      }

      const issueId =
        event.dataTransfer.getData(LINEAR_BOARD_DRAG_ISSUE_MIME) || linearBoardDraggingIssueId
      const issue = filteredLinearIssues.find((item) => item.id === issueId)
      if (
        !issue ||
        linearBoardUpdatingIssueIds.has(issue.id) ||
        (issue.state.name === targetState.name && issue.state.type === targetState.type)
      ) {
        return
      }

      setLinearBoardUpdatingIssueIds((prev) => {
        const next = new Set(prev)
        next.add(issue.id)
        return next
      })

      const previousState = issue.state
      const applyFallbackState = (state: LinearIssue['state']) => {
        setSelectedLinearIssueFallback((prev) =>
          prev?.id === issue.id ? { ...prev, state } : prev
        )
      }

      try {
        const states = await linearTeamStates(settings, issue.team.id, issue.workspaceId)
        const workflowState = findLinearWorkflowStateForStatus(states, targetState)
        if (!workflowState) {
          toast.error(`"${targetState.name}" is not available for ${issue.team.name}`)
          return
        }

        const nextState: LinearIssue['state'] = {
          name: workflowState.name,
          type: workflowState.type,
          color: workflowState.color
        }

        patchLinearIssue(issue.id, { state: nextState })
        patchScopedLinearIssue(issue.id, { state: nextState })
        applyFallbackState(nextState)

        const result = await linearUpdateIssue(
          settings,
          issue.id,
          { stateId: workflowState.id },
          issue.workspaceId
        )
        if (result.ok === false) {
          patchLinearIssue(issue.id, { state: previousState })
          patchScopedLinearIssue(issue.id, { state: previousState })
          applyFallbackState(previousState)
          toast.error(result.error ?? 'Failed to update Linear state')
        }
      } catch {
        patchLinearIssue(issue.id, { state: previousState })
        patchScopedLinearIssue(issue.id, { state: previousState })
        applyFallbackState(previousState)
        toast.error('Failed to update Linear state')
      } finally {
        setLinearBoardUpdatingIssueIds((prev) => {
          const next = new Set(prev)
          next.delete(issue.id)
          return next
        })
      }
    },
    [
      filteredLinearIssues,
      linearBoardDraggingIssueId,
      linearBoardUpdatingIssueIds,
      linearStatusBoardEnabled,
      patchScopedLinearIssue,
      patchLinearIssue,
      settings
    ]
  )

  const toggleLinearDisplayProperty = useCallback((property: LinearDisplayProperty): void => {
    if (property === 'team') {
      setLinearTeamPropertyTouched(true)
    }
    setLinearDisplayProperties((prev) => {
      const next = new Set(prev)
      if (next.has(property)) {
        next.delete(property)
      } else {
        next.add(property)
      }
      return next
    })
  }, [])

  const displayedJiraIssues = useMemo(
    () =>
      jiraIssues.map(
        (issue) =>
          findTaskPageJiraIssue(
            jiraCacheSnapshot.issueCache,
            jiraCacheSnapshot.searchCache,
            issue.key
          ) ?? issue
      ),
    [jiraIssues, jiraCacheSnapshot.issueCache, jiraCacheSnapshot.searchCache]
  )

  // New Linear issue dialog state
  const [newLinearIssueOpen, setNewLinearIssueOpen] = useState(false)
  const [newLinearIssueTitle, setNewLinearIssueTitle] = useState('')
  const [newLinearIssueBody, setNewLinearIssueBody] = useState('')
  const [newLinearIssueTeamId, setNewLinearIssueTeamId] = useState<string | null>(null)
  const [newLinearIssueSubmitting, setNewLinearIssueSubmitting] = useState(false)

  const [newLinearIssueStateId, setNewLinearIssueStateId] = useState<string | null>(null)
  const [newLinearIssueAssigneeId, setNewLinearIssueAssigneeId] = useState<string | null>(null)
  const [newLinearIssuePriority, setNewLinearIssuePriority] = useState<number>(0)
  const [newLinearIssueProjectId, setNewLinearIssueProjectId] = useState<string | null>(null)
  const [newLinearIssueLabelIds, setNewLinearIssueLabelIds] = useState<string[]>([])

  const newLinearIssueTargetTeam = useMemo(
    () => availableTeams.find((t) => t.id === newLinearIssueTeamId) ?? availableTeams[0] ?? null,
    [availableTeams, newLinearIssueTeamId]
  )

  const [newLinearIssueProjects, setNewLinearIssueProjects] = useState<LinearProjectSummary[]>([])
  const [newLinearIssueProjectsLoading, setNewLinearIssueProjectsLoading] = useState(false)

  useEffect(() => {
    let cancelled = false
    if (!newLinearIssueTargetTeam) {
      setNewLinearIssueProjects([])
      setNewLinearIssueProjectsLoading(false)
      return
    }
    setNewLinearIssueProjectsLoading(true)
    const targetWorkspaceId =
      newLinearIssueTargetTeam.workspaceId ||
      (selectedLinearWorkspaceId !== 'all' ? selectedLinearWorkspaceId : null)
    linearListProjects(settings, undefined, 100, targetWorkspaceId)
      .then((p) => {
        if (!cancelled) {
          setNewLinearIssueProjects(p.items)
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) {
          setNewLinearIssueProjectsLoading(false)
        }
      })
    return () => {
      // Why: project lists are workspace-scoped; stale responses must not
      // populate the composer after a team/workspace switch.
      cancelled = true
    }
  }, [newLinearIssueTargetTeam, settings, selectedLinearWorkspaceId])

  useEffect(() => {
    // Why: the selected team can change indirectly when the available Linear
    // teams/workspace list refreshes, even if the explicit picker value did not.
    setNewLinearIssueStateId(null)
    setNewLinearIssueAssigneeId(null)
    setNewLinearIssuePriority(0)
    if (
      selectedLinearProject &&
      selectedLinearProject.workspaceId === newLinearIssueTargetTeam?.workspaceId
    ) {
      setNewLinearIssueProjectId(selectedLinearProject.id)
    } else {
      setNewLinearIssueProjectId(null)
    }
    setNewLinearIssueLabelIds([])
  }, [newLinearIssueTargetTeam?.id, newLinearIssueTargetTeam?.workspaceId, selectedLinearProject])

  const newLinearStates = useTeamStates(
    newLinearIssueTargetTeam?.id || null,
    settings,
    newLinearIssueTargetTeam?.workspaceId
  )
  const newLinearMembers = useTeamMembers(
    newLinearIssueTargetTeam?.id || null,
    settings,
    newLinearIssueTargetTeam?.workspaceId
  )
  const newLinearLabels = useTeamLabels(
    newLinearIssueTargetTeam?.id || null,
    settings,
    newLinearIssueTargetTeam?.workspaceId
  )

  useEffect(() => {
    if (newLinearStates.data.length > 0 && !newLinearIssueStateId) {
      const defaultState =
        newLinearStates.data.find((s) => s.type === 'unstarted') || newLinearStates.data[0]
      if (defaultState) {
        setNewLinearIssueStateId(defaultState.id)
      }
    }
  }, [newLinearStates.data, newLinearIssueStateId])

  const [linearConnectOpen, setLinearConnectOpen] = useState(false)
  useContextualTour(
    'tasks',
    !dialogWorkItem &&
      !gitlabDialogItem &&
      !selectedLinearIssue &&
      !newIssueOpen &&
      !newLinearIssueOpen &&
      !linearConnectOpen &&
      activeModal === 'none',
    'tasks_open'
  )

  const activeGithubTaskKind = getGitHubTaskKind(activeTaskPreset, appliedTaskSearch)
  const selectedGitHubRepoExternalLink = useMemo(() => {
    if (selectedRepos.length !== 1) {
      return null
    }
    const [repo] = selectedRepos
    const sourceState = perRepoSourceState.find((state) => state.repoId === repo.id)
    const sources = sourceState?.sources
    const slug =
      activeGithubTaskKind === 'issues'
        ? (sources?.issues ?? sources?.prs)
        : (sources?.prs ?? sources?.issues)
    const url = buildGitHubRepoUrl(slug)
    return url ? { url, label: slug ? `${slug.owner}/${slug.repo}` : repo.displayName } : null
  }, [activeGithubTaskKind, perRepoSourceState, selectedRepos])

  const [newJiraIssueOpen, setNewJiraIssueOpen] = useState(false)
  const [newJiraIssueTitle, setNewJiraIssueTitle] = useState('')
  const [newJiraIssueBody, setNewJiraIssueBody] = useState('')
  const [newJiraIssueProjectId, setNewJiraIssueProjectId] = useState<string | null>(null)
  const [newJiraIssueProjectComboboxOpen, setNewJiraIssueProjectComboboxOpen] = useState(false)
  const [newJiraIssueProjectQuery, setNewJiraIssueProjectQuery] = useState('')
  const [newJiraIssueProjectCommandValue, setNewJiraIssueProjectCommandValue] = useState('')
  const [newJiraIssueTypeId, setNewJiraIssueTypeId] = useState<string | null>(null)
  const [newJiraIssueSubmitting, setNewJiraIssueSubmitting] = useState(false)
  const newJiraIssueProjectSearchInputRef = useRef<HTMLInputElement | null>(null)
  const [availableJiraIssueTypes, setAvailableJiraIssueTypes] = useState<JiraIssueType[]>([])
  const [jiraIssueTypesLoading, setJiraIssueTypesLoading] = useState(false)
  const [jiraCreateFields, setJiraCreateFields] = useState<JiraCreateField[]>([])
  const [jiraCreateFieldsLoading, setJiraCreateFieldsLoading] = useState(false)
  const [jiraCreateFieldsError, setJiraCreateFieldsError] = useState<string | null>(null)
  const [newJiraIssueCustomFieldValues, setNewJiraIssueCustomFieldValues] = useState<
    Record<string, string>
  >({})
  const [jiraConnectOpen, setJiraConnectOpen] = useState(false)
  const [jiraSiteUrlDraft, setJiraSiteUrlDraft] = useState('')
  const [jiraEmailDraft, setJiraEmailDraft] = useState('')
  const [jiraApiTokenDraft, setJiraApiTokenDraft] = useState('')
  const [jiraConnectState, setJiraConnectState] = useState<'idle' | 'connecting' | 'error'>('idle')
  const [jiraConnectError, setJiraConnectError] = useState<string | null>(null)
  const includeJiraSiteNameInProjectLabel = selectedJiraSiteId === 'all'

  const sortedAvailableJiraProjects = useMemo(
    () =>
      [...availableJiraProjects].sort((a, b) =>
        compareJiraProjectsByDisplayLabel(a, b, includeJiraSiteNameInProjectLabel)
      ),
    [availableJiraProjects, includeJiraSiteNameInProjectLabel]
  )

  const filteredNewJiraIssueProjects = useMemo(() => {
    const query = newJiraIssueProjectQuery.trim().toLocaleLowerCase()
    if (!query) {
      return sortedAvailableJiraProjects
    }
    return sortedAvailableJiraProjects.filter((project) =>
      getJiraProjectSearchText(project, includeJiraSiteNameInProjectLabel).includes(query)
    )
  }, [includeJiraSiteNameInProjectLabel, newJiraIssueProjectQuery, sortedAvailableJiraProjects])

  const newJiraIssueTargetProject = useMemo(
    () =>
      sortedAvailableJiraProjects.find(
        (project) => getJiraProjectSelectionKey(project) === newJiraIssueProjectId
      ) ??
      sortedAvailableJiraProjects[0] ??
      null,
    [newJiraIssueProjectId, sortedAvailableJiraProjects]
  )

  const newJiraIssueTargetProjectSelectionKey = newJiraIssueTargetProject
    ? getJiraProjectSelectionKey(newJiraIssueTargetProject)
    : ''

  const newJiraIssueTargetType = useMemo(
    () =>
      availableJiraIssueTypes.find((issueType) => issueType.id === newJiraIssueTypeId) ??
      availableJiraIssueTypes[0] ??
      null,
    [availableJiraIssueTypes, newJiraIssueTypeId]
  )

  const visibleJiraCreateFields = useMemo(
    () => jiraCreateFields.filter(isVisibleJiraCreateField),
    [jiraCreateFields]
  )

  const hasMissingJiraCreateField = useMemo(
    () =>
      visibleJiraCreateFields.some(
        (field) => !(newJiraIssueCustomFieldValues[field.key] ?? '').trim()
      ),
    [newJiraIssueCustomFieldValues, visibleJiraCreateFields]
  )

  useEffect(() => {
    if (!newJiraIssueProjectComboboxOpen) {
      return
    }
    const frame = requestAnimationFrame(() => {
      const input = newJiraIssueProjectSearchInputRef.current
      if (!input) {
        return
      }
      input.focus()
      const end = input.value.length
      input.setSelectionRange(end, end)
    })
    return () => cancelAnimationFrame(frame)
  }, [newJiraIssueProjectComboboxOpen])

  const handleNewJiraIssueProjectComboboxOpenChange = useCallback(
    (open: boolean) => {
      setNewJiraIssueProjectComboboxOpen(open)
      if (open) {
        setNewJiraIssueProjectCommandValue(newJiraIssueTargetProjectSelectionKey)
        return
      }
      setNewJiraIssueProjectQuery('')
    },
    [newJiraIssueTargetProjectSelectionKey]
  )

  const handleNewJiraIssueProjectSelect = useCallback((selectionKey: string) => {
    setNewJiraIssueProjectId(selectionKey)
    setNewJiraIssueTypeId(null)
    setNewJiraIssueProjectCommandValue(selectionKey)
    setNewJiraIssueProjectComboboxOpen(false)
    setNewJiraIssueProjectQuery('')
  }, [])

  const handleNewJiraIssueProjectTriggerKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (newJiraIssueProjectComboboxOpen) {
        return
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        setNewJiraIssueProjectCommandValue(newJiraIssueTargetProjectSelectionKey)
        setNewJiraIssueProjectComboboxOpen(true)
        return
      }
      if (event.metaKey || event.ctrlKey || event.altKey) {
        return
      }
      if (event.key.length === 1 && /\S/.test(event.key)) {
        event.preventDefault()
        setNewJiraIssueProjectCommandValue(newJiraIssueTargetProjectSelectionKey)
        setNewJiraIssueProjectQuery(event.key)
        setNewJiraIssueProjectComboboxOpen(true)
      }
    },
    [newJiraIssueProjectComboboxOpen, newJiraIssueTargetProjectSelectionKey]
  )

  useEffect(() => {
    if (!newJiraIssueOpen || !newJiraIssueTargetProject) {
      setAvailableJiraIssueTypes([])
      setJiraIssueTypesLoading(false)
      return
    }
    let cancelled = false
    setAvailableJiraIssueTypes([])
    setJiraIssueTypesLoading(true)
    void jiraListIssueTypes(
      settings,
      newJiraIssueTargetProject.id,
      newJiraIssueTargetProject.siteId
    )
      .then((issueTypes) => {
        if (cancelled) {
          return
        }
        setAvailableJiraIssueTypes(issueTypes)
        setNewJiraIssueTypeId(issueTypes[0]?.id ?? null)
      })
      .catch(() => {
        if (!cancelled) {
          toast.error('Failed to load Jira issue types.')
        }
      })
      .finally(() => {
        if (!cancelled) {
          setJiraIssueTypesLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [settings, newJiraIssueOpen, newJiraIssueTargetProject])

  useEffect(() => {
    if (!newJiraIssueOpen || !newJiraIssueTargetProject || !newJiraIssueTargetType) {
      setJiraCreateFields([])
      setJiraCreateFieldsLoading(false)
      setJiraCreateFieldsError(null)
      setNewJiraIssueCustomFieldValues({})
      return
    }
    let cancelled = false
    setJiraCreateFields([])
    setJiraCreateFieldsLoading(true)
    setJiraCreateFieldsError(null)
    setNewJiraIssueCustomFieldValues({})
    void jiraListCreateFields(
      settings,
      newJiraIssueTargetProject.id,
      newJiraIssueTargetType.id,
      newJiraIssueTargetProject.siteId
    )
      .then((fields) => {
        if (!cancelled) {
          setJiraCreateFields(fields)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setJiraCreateFieldsError('Failed to load required Jira fields.')
        }
      })
      .finally(() => {
        if (!cancelled) {
          setJiraCreateFieldsLoading(false)
        }
      })
    return () => {
      // Why: create fields are scoped to project + issue type; ignore late
      // responses after the user switches either selector.
      cancelled = true
    }
  }, [settings, newJiraIssueOpen, newJiraIssueTargetProject, newJiraIssueTargetType])

  // Why: defense-in-depth safety net applied to the current page's items.
  // The active tab scopes requests to issues or PRs, and this keeps stale
  // cache rows from leaking across the split tabs.
  const applyTypeFilter = useCallback(
    (items: GitHubWorkItem[]) => {
      return items.filter((item) => {
        return activeGithubTaskKind === 'prs' ? item.type === 'pr' : item.type === 'issue'
      })
    },
    [activeGithubTaskKind]
  )

  const currentPageItems = useMemo(() => pages[currentPage] ?? [], [pages, currentPage])

  const filteredWorkItems = useMemo(
    () => applyTypeFilter(currentPageItems),
    [applyTypeFilter, currentPageItems]
  )
  const showGitHubTaskSkeletons = tasksFiltering || (tasksLoading && filteredWorkItems.length === 0)
  const loadedGitHubAuthorLogins = useMemo(() => {
    const seen = new Set<string>()
    const logins: string[] = []
    for (const page of pages) {
      for (const item of page) {
        if (
          !item.author ||
          (activeGithubTaskKind === 'prs' ? item.type !== 'pr' : item.type !== 'issue')
        ) {
          continue
        }
        const key = item.author.toLowerCase()
        if (seen.has(key)) {
          continue
        }
        seen.add(key)
        logins.push(item.author)
      }
    }
    return logins
  }, [activeGithubTaskKind, pages])
  const primaryGithubFilterSlug = useMemo(() => {
    for (const state of perRepoSourceState) {
      const source = activeGithubTaskKind === 'prs' ? state.sources?.prs : state.sources?.issues
      if (source) {
        return source
      }
    }
    return null
  }, [activeGithubTaskKind, perRepoSourceState])
  const showPRManagementColumns = activeGithubTaskKind === 'prs'
  const githubTaskGridClass = showPRManagementColumns
    ? GITHUB_PR_TASK_GRID_CLASS
    : GITHUB_TASK_GRID_CLASS

  const ensurePRChecksLoaded = useCallback(
    (item: GitHubWorkItem): void => {
      if (item.type !== 'pr' || item.checksSummary) {
        return
      }
      const repo = repoMap.get(item.repoId)
      if (!repo) {
        return
      }
      const requestedHeadSha = item.headSha
      const requestedPRRepo = item.prRepo ?? null
      void fetchPRChecks(
        repo.path,
        item.number,
        item.branchName,
        item.headSha,
        item.prRepo ?? null,
        { repoId: repo.id }
      ).then((checks) => {
        patchTaskPageWorkItemRows(
          { id: item.id, repoId: item.repoId },
          { checksSummary: deriveTaskPagePRCheckSummary(checks) },
          (currentItem) =>
            currentItem.type === 'pr' &&
            currentItem.headSha === requestedHeadSha &&
            sameOptionalGitHubOwnerRepo(currentItem.prRepo, requestedPRRepo)
        )
      })
    },
    [fetchPRChecks, patchTaskPageWorkItemRows, repoMap]
  )

  useEffect(() => {
    if (taskSource !== 'github' || githubMode !== 'items' || !showPRManagementColumns) {
      return
    }

    for (const item of filteredWorkItems.slice(0, PR_CHECKS_EAGER_PREFETCH_LIMIT)) {
      ensurePRChecksLoaded(item)
    }
  }, [ensurePRChecksLoaded, filteredWorkItems, githubMode, showPRManagementColumns, taskSource])

  // Why: each page is bounded by both the per-repo fetch budget (so a single
  // repo can yield at most PER_REPO_FETCH_LIMIT rows per page) and the
  // post-merge display cap. Dividing the total by CROSS_REPO_DISPLAY_LIMIT
  // alone under-counts pages when the per-repo budget is the tighter bound —
  // e.g. one repo with 60 open PRs yielded 36 rows on page 0 and ceil(60/100)
  // = 1 total pages, hiding the pager entirely.
  const effectivePageSize = Math.max(
    1,
    Math.min(PER_REPO_FETCH_LIMIT * Math.max(1, selectedRepos.length), CROSS_REPO_DISPLAY_LIMIT)
  )
  // Why: if the search-API count is unavailable (rate-limited, transient
  // failure — `countWorkItemsAcrossRepos` swallows errors and returns 0),
  // infer there's at least one more page whenever the last loaded page
  // filled to the per-page capacity. Otherwise pagination would silently
  // hide and trap the user on page 0 with no way to advance.
  const lastPageFull = (pages.at(-1)?.length ?? 0) >= effectivePageSize
  const totalPages =
    totalItemCount && totalItemCount > 0
      ? Math.max(pages.length, Math.ceil(totalItemCount / effectivePageSize))
      : lastPageFull
        ? pages.length + 1
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
      const scoped = scopeGitHubTaskSearch(taskSearchInput, activeGithubTaskKind)
      if (scoped !== appliedTaskSearch) {
        setTasksFiltering(true)
      }
      setAppliedTaskSearch(scoped)
    }, TASK_SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timeout)
  }, [activeGithubTaskKind, appliedTaskSearch, taskSearchInput, taskResumeApplied])

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
      setTasksRefreshing(false)
      setTasksFiltering(false)
      return
    }
    if (selectedRepos.length === 0) {
      setRetryingRepoPaths(new Set())
      setTasksRefreshing(false)
      setTasksFiltering(false)
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
    let anyRepoCached = false
    for (const r of selectedRepos) {
      const cached = getCachedWorkItems(r.id, PER_REPO_FETCH_LIMIT, q)
      if (cached === null) {
        anyUncached = true
      } else {
        anyRepoCached = true
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
    const forcedFetch = (forceRefresh && taskRefreshNonce > 0) || preferenceInvalidated
    const repoArgs = selectedRepos.map((r) => ({ repoId: r.id, path: r.path }))
    const landingRefreshKey = `${repoArgs.map((r) => `${r.repoId}:${r.path}`).join('|')}::${q}`
    const shouldProbeOnLanding =
      !forcedFetch && anyRepoCached && !landingGitHubRefreshKeysRef.current.has(landingRefreshKey)
    if (shouldProbeOnLanding) {
      landingGitHubRefreshKeysRef.current = new Set([
        ...landingGitHubRefreshKeysRef.current,
        landingRefreshKey
      ])
    }
    // Why: manual refresh keeps cached rows visible, so the normal
    // `tasksLoading` flag may stay false. Track the forced fetch separately
    // so the toolbar still shows a refresh-in-progress affordance.
    setTasksRefreshing(forcedFetch)

    // Why: snapshot the retrying paths at effect-dispatch so overlapping
    // retries don't clear each other's pending state. An earlier cancelled
    // effect settling after a newer retry starts would otherwise wipe the
    // newer retry's repo from the set. Clearing only the paths captured
    // when this effect dispatched preserves later additions.
    const dispatchedRetryPaths = retryingRepoPaths
    void fetchWorkItemsAcrossRepos(repoArgs, PER_REPO_FETCH_LIMIT, CROSS_REPO_DISPLAY_LIMIT, q, {
      ...deriveTaskPageGitHubWorkItemsFetchOptions(forcedFetch, shouldProbeOnLanding)
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
        if (shouldProbeOnLanding) {
          const replaceFirstPage = shouldReplaceTaskPageItemsAfterRefresh(page0, items)
          const resetPagination = shouldResetTaskPagePaginationAfterLandingRefresh(page0, items)
          setPages((current) => reconcileTaskPagePagesAfterLandingRefresh(current, items))
          if (replaceFirstPage || resetPagination) {
            setCurrentPage(0)
          }
        } else {
          setPages([items])
          setCurrentPage(0)
        }
        setFailedCount(failed)
        setTasksLoading(false)
        setTasksRefreshing(false)
        setTasksFiltering(false)
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
        setTasksRefreshing(false)
        setTasksFiltering(false)
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

  const applyPRFilterChange = useCallback(
    (change: PRFilterChange): void => {
      let next = scopeGitHubTaskSearch(taskSearchInput, activeGithubTaskKind)
      // Why: each filter dropdown contributes an independent qualifier patch.
      // `withQualifier` round-trips through parseTaskQuery so prior filters and
      // free-text are preserved.
      if ('author' in change) {
        next = withQualifier(next, 'author', change.author ?? null)
      }
      if ('assignee' in change) {
        next = withQualifier(next, 'assignee', change.assignee ?? null)
      }
      if ('labels' in change) {
        next = withQualifier(next, 'labels', change.labels ?? [])
      }
      if ('state' in change && change.state) {
        next = withQualifier(next, 'state', change.state)
        if (change.state !== 'open') {
          next = withQualifier(next, 'draft', null)
        }
      }
      if ('draft' in change) {
        next = withQualifier(next, 'draft', change.draft ? 'true' : 'false')
      }
      if ('reviewer' in change) {
        // Why: the two reviewer qualifiers (review-requested vs reviewed-by) are
        // mutually exclusive in the PR-list UX — clear the other axis whenever
        // one is set so the chip's visible state matches the actual query.
        const reviewer = change.reviewer ?? null
        if (reviewer === null) {
          next = withQualifier(next, 'reviewRequested', null)
          next = withQualifier(next, 'reviewedBy', null)
        } else if (reviewer.kind === 'requested') {
          next = withQualifier(next, 'reviewedBy', null)
          next = withQualifier(next, 'reviewRequested', reviewer.login)
        } else {
          next = withQualifier(next, 'reviewRequested', null)
          next = withQualifier(next, 'reviewedBy', reviewer.login)
        }
      }
      setTaskSearchInput(next)
      setAppliedTaskSearch(next)
      setActiveTaskPreset(null)
      setTaskResumeState({ githubItemsPreset: null, githubItemsQuery: next })
      // Why: filter changes replace the meaning of every row. Showing stale
      // rows while the filtered query resolves reads like the filter did
      // nothing, so render the same skeleton used for an uncached initial load.
      setTasksFiltering(true)
      setTaskRefreshNonce((current) => current + 1)
    },
    [activeGithubTaskKind, setTaskResumeState, taskSearchInput]
  )

  const handleApplyTaskSearch = useCallback((): void => {
    const scoped = scopeGitHubTaskSearch(taskSearchInput, activeGithubTaskKind)
    setTaskSearchInput(scoped)
    setAppliedTaskSearch(scoped)
    setActiveTaskPreset(null)
    setTaskResumeState({ githubItemsPreset: null, githubItemsQuery: scoped })
    setTasksFiltering(true)
    setTaskRefreshNonce((current) => current + 1)
  }, [activeGithubTaskKind, setTaskResumeState, taskSearchInput])

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

  const handleSelectGithubTaskKind = useCallback(
    (kind: GitHubTaskKind): void => {
      const preset = getDefaultPresetForGitHubTaskKind(kind)
      const query = getTaskPresetQuery(preset)
      setTaskSearchInput(query)
      setAppliedTaskSearch(query)
      setActiveTaskPreset(preset)
      setTaskResumeState({
        githubItemsPreset: preset,
        githubItemsQuery: query
      })
      setTasksFiltering(true)
      setTaskRefreshNonce((current) => current + 1)
    },
    [setTaskResumeState]
  )

  const handleResetGithubTaskSearch = useCallback((): void => {
    handleSelectGithubTaskKind(activeGithubTaskKind)
  }, [activeGithubTaskKind, handleSelectGithubTaskKind])

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
      newIssueOpen ||
      newLinearIssueOpen ||
      newJiraIssueOpen ||
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
    githubMode,
    newIssueOpen,
    newLinearIssueOpen,
    newJiraIssueOpen,
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
        prefilledName: getGitHubWorkItemWorkspaceSeed(item),
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

  const handleOpenOrUseGitHubWorkItem = useCallback(
    (item: GitHubWorkItem): void => {
      const currentAttached = findGithubWorkItemWorkspaceAttachment(
        useAppStore.getState().allWorktrees(),
        item.repoId,
        item.type,
        item.number
      )
      if (!currentAttached) {
        handleUseWorkItem(item)
        return
      }

      const result = activateAndRevealWorktree(currentAttached.id)
      if (result === false) {
        toast.error(
          item.type === 'pr'
            ? 'Unable to open the workspace attached to this pull request.'
            : 'Unable to open the workspace attached to this issue.'
        )
      }
    },
    [handleUseWorkItem]
  )

  const openComposerForGitLabItem = useCallback(
    (item: GitLabWorkItem): void => {
      const linkedWorkItem: LinkedWorkItemSummary = {
        type: item.type,
        number: item.number,
        title: item.title,
        url: item.url
      }
      openModal('new-workspace-composer', {
        linkedWorkItem,
        prefilledName: getGitLabWorkItemWorkspaceSeed(item),
        initialRepoId: item.repoId,
        telemetrySource: 'sidebar'
      })
    },
    [openModal]
  )

  const handleUseGitLabItem = useCallback(
    (item: GitLabWorkItem): void => {
      openComposerForGitLabItem(item)
    },
    [openComposerForGitLabItem]
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
      const result = newIssueRuntimeTarget
        ? await callRuntimeRpc<Awaited<ReturnType<typeof window.api.gh.createIssue>>>(
            newIssueRuntimeTarget,
            'github.createIssue',
            {
              repo: newIssueTargetRepo.id,
              title,
              body: newIssueBody,
              labels: newIssueLabels,
              assignees: newIssueAssignees.map((assignee) => assignee.login)
            },
            { timeoutMs: 30_000 }
          )
        : await window.api.gh.createIssue({
            repoPath: newIssueTargetRepo.path,
            repoId: newIssueTargetRepo.id,
            title,
            body: newIssueBody,
            labels: newIssueLabels,
            assignees: newIssueAssignees.map((assignee) => assignee.login)
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
      setNewIssueLabels([])
      setNewIssueAssignees([])
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
        labels: newIssueLabels,
        assignees: newIssueAssignees,
        updatedAt: new Date().toISOString(),
        author: null
      }
      openGitHubDetailPage(stub)
      const stubRepoId = newIssueTargetRepo.id
      const fullIssuePromise = newIssueRuntimeTarget
        ? callRuntimeRpc<Awaited<ReturnType<typeof window.api.gh.workItem>>>(
            newIssueRuntimeTarget,
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
  }, [
    newIssueBody,
    newIssueAssignees,
    newIssueLabels,
    newIssueRuntimeTarget,
    newIssueSubmitting,
    newIssueTargetRepo,
    newIssueTitle,
    openGitHubDetailPage,
    setDialogWorkItem
  ])

  const handleCreateNewLinearIssue = useCallback(async (): Promise<void> => {
    if (!newLinearIssueTargetTeam) {
      return
    }
    const title = newLinearIssueTitle.trim()
    if (!title || newLinearIssueSubmitting) {
      return
    }
    if (
      selectedLinearProject &&
      newLinearIssueProjectId === selectedLinearProject.id &&
      newLinearIssueTargetTeam.workspaceId !== selectedLinearProject.workspaceId
    ) {
      toast.error('Select a team from the project workspace before filing this issue.')
      return
    }
    setNewLinearIssueSubmitting(true)
    try {
      const result = await linearCreateIssue(settings, {
        teamId: newLinearIssueTargetTeam.id,
        title,
        description: newLinearIssueBody || undefined,
        workspaceId: newLinearIssueTargetTeam.workspaceId,
        stateId: newLinearIssueStateId || undefined,
        priority: newLinearIssuePriority,
        assigneeId: newLinearIssueAssigneeId || undefined,
        projectId: newLinearIssueProjectId || null,
        labelIds: newLinearIssueLabelIds.length > 0 ? newLinearIssueLabelIds : undefined
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
      setNewLinearIssueStateId(null)
      setNewLinearIssueAssigneeId(null)
      setNewLinearIssuePriority(0)
      setNewLinearIssueProjectId(null)
      setNewLinearIssueLabelIds([])
      setLinearRefreshNonce((n) => n + 1)

      // Why: auto-select the new issue in the inline workspace so the user
      // sees exactly what was filed, mirroring the GitHub create-issue flow.
      void linearGetIssue(settings, result.id, newLinearIssueTargetTeam.workspaceId)
        .then((full) => {
          if (full) {
            openLinearDetailPage(full)
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
    newLinearIssueStateId,
    newLinearIssuePriority,
    newLinearIssueAssigneeId,
    newLinearIssueProjectId,
    newLinearIssueLabelIds,
    openLinearDetailPage,
    selectedLinearProject,
    settings
  ])

  const handleCreateNewJiraIssue = useCallback(async (): Promise<void> => {
    if (!newJiraIssueTargetProject || !newJiraIssueTargetType) {
      return
    }
    const title = newJiraIssueTitle.trim()
    if (!title || newJiraIssueSubmitting || hasMissingJiraCreateField || jiraCreateFieldsLoading) {
      return
    }
    const customFields = buildJiraCreateCustomFields(
      visibleJiraCreateFields,
      newJiraIssueCustomFieldValues
    )
    setNewJiraIssueSubmitting(true)
    try {
      const result = await jiraCreateIssue(settings, {
        siteId: newJiraIssueTargetProject.siteId,
        projectId: newJiraIssueTargetProject.id,
        issueTypeId: newJiraIssueTargetType.id,
        title,
        description: newJiraIssueBody || undefined,
        customFields
      })
      if (!result.ok) {
        toast.error(result.error || 'Failed to create Jira issue.')
        return
      }
      toast.success(`Created ${result.key}`, {
        action: result.url
          ? {
              label: 'View',
              onClick: () => window.open(result.url, '_blank')
            }
          : undefined
      })
      setNewJiraIssueOpen(false)
      setNewJiraIssueTitle('')
      setNewJiraIssueBody('')
      setNewJiraIssueCustomFieldValues({})
      setJiraRefreshNonce((n) => n + 1)

      void jiraGetIssue(settings, result.key, newJiraIssueTargetProject.siteId)
        .then((full) => {
          if (full) {
            // Why: the list cache may still be fresh after create; insert the
            // new row locally before selecting it so the inspector stays open.
            setJiraIssues((prev) => [full, ...prev.filter((issue) => issue.key !== full.key)])
            setSelectedJiraIssue(full)
          }
        })
        .catch(() => {})
    } finally {
      setNewJiraIssueSubmitting(false)
    }
  }, [
    hasMissingJiraCreateField,
    jiraCreateFieldsLoading,
    newJiraIssueBody,
    newJiraIssueCustomFieldValues,
    newJiraIssueSubmitting,
    newJiraIssueTargetProject,
    newJiraIssueTargetType,
    newJiraIssueTitle,
    settings,
    setSelectedJiraIssue,
    visibleJiraCreateFields
  ])

  const githubTasksBusy = tasksLoading || tasksRefreshing || tasksFiltering

  useEffect(() => {
    // Why: when a modal is open, let it own Esc dismissal.
    if (
      dialogWorkItem ||
      selectedLinearIssue ||
      newIssueOpen ||
      newLinearIssueOpen ||
      newJiraIssueOpen ||
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
    newIssueOpen,
    newLinearIssueOpen,
    newJiraIssueOpen,
    selectedLinearIssue
  ])

  useEffect(() => {
    if (!preflightStatusChecked) {
      void refreshPreflightStatus()
    }
    if (!linearStatusChecked) {
      void checkLinearConnection()
    }
    if (!jiraStatusChecked) {
      void checkJiraConnection()
    }
  }, [
    checkJiraConnection,
    checkLinearConnection,
    jiraStatusChecked,
    linearStatusChecked,
    preflightStatusChecked,
    refreshPreflightStatus
  ])

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

  useEffect(() => {
    setLinearIssueLimit(LINEAR_ITEM_LIMIT)
    setLinearIssuePage(0)
    setLinearIssueLoadingTargetPage(null)
  }, [
    appliedLinearSearch,
    linearMode,
    selectedLinearCustomView?.id,
    selectedLinearProject?.id,
    selectedLinearWorkspaceId,
    taskSource
  ])

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
    if (linearMode !== 'issues') {
      return
    }
    if (!linearStatus.connected) {
      return
    }

    let cancelled = false
    setLinearError(null)

    const trimmed = appliedLinearSearch.trim()
    const effectiveLinearIssueLimit = clampLinearIssueListLimit(linearIssueLimit)
    const readArgs =
      trimmed.length > 0
        ? ({ kind: 'search', query: trimmed, limit: LINEAR_ITEM_LIMIT } as const)
        : ({ kind: 'list', filter: 'all', limit: effectiveLinearIssueLimit } as const)
    const cachedResult = getCachedLinearIssues(readArgs)
    if (readArgs.kind === 'search') {
      setLinearIssuesHasMore(false)
      if (cachedResult) {
        setLinearIssues(cachedResult as LinearIssue[])
      }
    } else if (cachedResult) {
      const collection = cachedResult as LinearCollectionResult<LinearIssue>
      setLinearIssues(collection.items)
      setLinearIssuesHasMore(
        Boolean(collection.hasMore) && effectiveLinearIssueLimit < LINEAR_ISSUE_LIST_MAX
      )
    }

    const requestSignature =
      trimmed.length > 0
        ? `${selectedLinearWorkspaceId ?? 'default'}::search::${trimmed}::${LINEAR_ITEM_LIMIT}`
        : `${selectedLinearWorkspaceId ?? 'default'}::list::all::${effectiveLinearIssueLimit}`
    const previousRequest = lastLinearRequestRef.current
    const forceRefresh =
      linearRefreshNonce > 0 &&
      previousRequest?.nonce !== linearRefreshNonce &&
      previousRequest?.signature === requestSignature
    lastLinearRequestRef.current = { nonce: linearRefreshNonce, signature: requestSignature }
    const shouldProbeOnLanding =
      !forceRefresh &&
      cachedResult !== null &&
      !landingLinearRefreshKeysRef.current.has(requestSignature)
    if (shouldProbeOnLanding) {
      landingLinearRefreshKeysRef.current = new Set([
        ...landingLinearRefreshKeysRef.current,
        requestSignature
      ])
    }

    // Why: cached rows should remain visible on navigation. Only an explicit
    // refresh or a true cache miss needs the blocking loading state.
    setLinearLoading(forceRefresh || cachedResult === null)

    const request =
      readArgs.kind === 'search'
        ? searchLinearIssues(readArgs.query, LINEAR_ITEM_LIMIT, {
            force: forceRefresh || shouldProbeOnLanding
          })
        : listLinearIssues(readArgs.filter, effectiveLinearIssueLimit, {
            force: forceRefresh || shouldProbeOnLanding
          })

    void request
      .then((result) => {
        if (
          cancelled ||
          lastLinearRequestRef.current?.signature !== requestSignature ||
          lastLinearRequestRef.current?.nonce !== linearRefreshNonce
        ) {
          return
        }
        if (readArgs.kind === 'search') {
          const issues = result as LinearIssue[]
          setLinearIssuesHasMore(false)
          if (shouldProbeOnLanding) {
            setLinearIssues((current) =>
              reconcileTaskPageLinearIssuesAfterLandingRefresh(current, issues)
            )
          } else {
            setLinearIssues(issues)
          }
        } else {
          const collection = result as LinearCollectionResult<LinearIssue>
          setLinearIssuesHasMore(
            Boolean(collection.hasMore) && effectiveLinearIssueLimit < LINEAR_ISSUE_LIST_MAX
          )
          setLinearIssues((current) =>
            shouldProbeOnLanding
              ? reconcileTaskPageLinearIssuesAfterLandingRefresh(current, collection.items)
              : collection.items
          )
        }
        setLinearLoading(false)
      })
      .catch((err) => {
        if (
          cancelled ||
          lastLinearRequestRef.current?.signature !== requestSignature ||
          lastLinearRequestRef.current?.nonce !== linearRefreshNonce
        ) {
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
    linearMode,
    linearStatus.connected,
    selectedLinearWorkspaceId,
    appliedLinearSearch,
    linearIssueLimit,
    linearRefreshNonce,
    taskResumeApplied,
    getCachedLinearIssues
  ])

  useEffect(() => {
    if (!taskResumeApplied) {
      return
    }
    const timeout = window.setTimeout(() => {
      setAppliedLinearProjectSearch(linearProjectSearchInput)
    }, TASK_SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timeout)
  }, [linearProjectSearchInput, taskResumeApplied])

  useEffect(() => {
    if (!taskResumeApplied || taskSource !== 'linear' || linearMode !== 'projects') {
      return
    }
    if (!linearStatus.connected || selectedLinearProject) {
      return
    }
    let cancelled = false
    const query = appliedLinearProjectSearch.trim()
    const cached = getCachedLinearProjects(query || undefined, LINEAR_ITEM_LIMIT)
    if (cached) {
      setLinearProjectsResult(cached)
    }
    const force = linearRefreshNonce > 0
    setLinearProjectsLoading(force || cached === null)
    setLinearProjectsError(null)
    void listLinearProjectsFromStore(query || undefined, LINEAR_ITEM_LIMIT, undefined, {
      force
    })
      .then((result) => {
        if (!cancelled) {
          setLinearProjectsResult(result)
          setLinearProjectsLoading(false)
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setLinearProjectsError(
            error instanceof Error ? error.message : 'Failed to load projects.'
          )
          setLinearProjectsLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    taskResumeApplied,
    taskSource,
    linearMode,
    linearStatus.connected,
    selectedLinearWorkspaceId,
    selectedLinearProject,
    appliedLinearProjectSearch,
    linearRefreshNonce,
    getCachedLinearProjects
  ])

  useEffect(() => {
    if (!selectedLinearProject?.workspaceId) {
      setSelectedLinearProjectDetail(null)
      return
    }
    let cancelled = false
    setLinearProjectDetailLoading(true)
    setLinearProjectDetailError(null)
    void fetchLinearProject(selectedLinearProject.id, selectedLinearProject.workspaceId, {
      force: linearRefreshNonce > 0
    })
      .then((project) => {
        if (!cancelled) {
          setSelectedLinearProjectDetail(project)
          setLinearProjectDetailLoading(false)
          if (!project) {
            setSelectedLinearProject(null)
            setLinearProjectParentView(null)
            setLinearProjectDetailError(null)
            setLinearProjectsError('Project was not found.')
            setTaskResumeState({ linearContext: undefined })
          }
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setLinearProjectDetailError(
            error instanceof Error ? error.message : 'Failed to load project.'
          )
          setLinearProjectDetailLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [fetchLinearProject, linearRefreshNonce, selectedLinearProject, setTaskResumeState])

  useEffect(() => {
    if (!selectedLinearProject?.workspaceId || linearProjectTab !== 'issues') {
      return
    }
    let cancelled = false
    setLinearProjectIssuesLoading(true)
    setLinearProjectIssuesError(null)
    const effectiveLimit = clampLinearIssueListLimit(linearProjectIssueLimit)
    void listLinearProjectIssues(
      selectedLinearProject.id,
      selectedLinearProject.workspaceId,
      effectiveLimit,
      { force: linearRefreshNonce > 0 }
    )
      .then((result) => {
        if (!cancelled) {
          setLinearProjectIssuesResult(result)
          setLinearProjectIssuesLoading(false)
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setLinearProjectIssuesError(
            error instanceof Error ? error.message : 'Failed to load project issues.'
          )
          setLinearProjectIssuesLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [
    linearProjectIssueLimit,
    linearProjectTab,
    linearRefreshNonce,
    listLinearProjectIssues,
    selectedLinearProject
  ])

  useEffect(() => {
    if (!taskResumeApplied || taskSource !== 'linear' || linearMode !== 'views') {
      return
    }
    if (!linearStatus.connected || selectedLinearCustomView) {
      return
    }
    let cancelled = false
    const cached = getCachedLinearCustomViews(linearCustomViewModel, LINEAR_ITEM_LIMIT)
    if (cached) {
      setLinearCustomViewsResult(cached)
    }
    const force = linearRefreshNonce > 0
    setLinearCustomViewsLoading(force || cached === null)
    setLinearCustomViewsError(null)
    void listLinearCustomViews(linearCustomViewModel, LINEAR_ITEM_LIMIT, undefined, { force })
      .then((result) => {
        if (!cancelled) {
          setLinearCustomViewsResult(result)
          setLinearCustomViewsLoading(false)
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setLinearCustomViewsError(
            error instanceof Error ? error.message : 'Failed to load views.'
          )
          setLinearCustomViewsLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    taskResumeApplied,
    taskSource,
    linearMode,
    linearStatus.connected,
    selectedLinearWorkspaceId,
    selectedLinearCustomView,
    linearCustomViewModel,
    linearRefreshNonce,
    getCachedLinearCustomViews
  ])

  useEffect(() => {
    if (!selectedLinearCustomView?.workspaceId) {
      setLinearCustomViewIssuesResult({ items: [] })
      setLinearCustomViewProjectsResult({ items: [] })
      return
    }
    let cancelled = false
    setLinearCustomViewContentsLoading(true)
    setLinearCustomViewContentsError(null)
    const issueLimit = clampLinearIssueListLimit(linearCustomViewIssueLimit)
    const request =
      selectedLinearCustomView.model === 'issue'
        ? listLinearCustomViewIssues(
            selectedLinearCustomView.id,
            selectedLinearCustomView.workspaceId,
            issueLimit,
            { force: linearRefreshNonce > 0 }
          )
        : listLinearCustomViewProjects(
            selectedLinearCustomView.id,
            selectedLinearCustomView.workspaceId,
            LINEAR_ITEM_LIMIT,
            { force: linearRefreshNonce > 0 }
          )
    void request
      .then((result) => {
        if (cancelled) {
          return
        }
        if (selectedLinearCustomView.model === 'issue') {
          setLinearCustomViewIssuesResult(result as LinearCollectionResult<LinearIssue>)
        } else {
          setLinearCustomViewProjectsResult(result as LinearCollectionResult<LinearProjectSummary>)
        }
        setLinearCustomViewContentsLoading(false)
      })
      .catch((error) => {
        if (!cancelled) {
          setLinearCustomViewContentsError(
            error instanceof Error ? error.message : 'Failed to load view contents.'
          )
          setLinearCustomViewContentsLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [
    linearRefreshNonce,
    linearCustomViewIssueLimit,
    listLinearCustomViewIssues,
    listLinearCustomViewProjects,
    selectedLinearCustomView
  ])

  useEffect(() => {
    if (!taskResumeApplied || taskSource !== 'linear') {
      return
    }

    if (!linearStatus.connected) {
      clearSelectedLinearIssue()
      return
    }

    if (filteredLinearIssues.length === 0) {
      if (!selectedLinearIssueCanFloat) {
        clearSelectedLinearIssue()
      }
      return
    }

    // Why: the corrected Linear surface is list-first. Keep an open inspector
    // only while its issue remains in the current filter instead of auto-opening
    // the first row and turning the list back into navigation chrome. Related
    // sub-issue navigation is allowed to stay open because it is user-directed.
    if (
      selectedLinearIssueId &&
      !selectedLinearIssueCanFloat &&
      !filteredLinearIssues.some((issue) => issue.id === selectedLinearIssueId)
    ) {
      clearSelectedLinearIssue()
    }
  }, [
    clearSelectedLinearIssue,
    filteredLinearIssues,
    linearStatus.connected,
    selectedLinearIssueCanFloat,
    selectedLinearIssueId,
    taskResumeApplied,
    taskSource
  ])

  useEffect(() => {
    if (!taskResumeApplied) {
      return
    }
    const timeout = window.setTimeout(() => {
      setAppliedJiraSearch(jiraSearchInput)
    }, TASK_SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timeout)
  }, [jiraSearchInput, taskResumeApplied])

  useEffect(() => {
    if (!taskResumeApplied) {
      return
    }
    if (!jiraSearchPersistReadyRef.current) {
      jiraSearchPersistReadyRef.current = true
      return
    }
    setTaskResumeState({ jiraQuery: appliedJiraSearch.trim() })
  }, [appliedJiraSearch, setTaskResumeState, taskResumeApplied])

  useEffect(() => {
    if (!taskResumeApplied) {
      return
    }
    if (taskSource !== 'jira') {
      return
    }
    if (!jiraStatus.connected) {
      return
    }

    let cancelled = false
    setJiraLoading(true)
    setJiraError(null)

    const trimmed = appliedJiraSearch.trim()
    const request =
      trimmed.length > 0
        ? searchJiraIssues(trimmed, JIRA_ITEM_LIMIT)
        : listJiraIssues(activeJiraPreset, JIRA_ITEM_LIMIT)

    void request
      .then((issues) => {
        if (cancelled) {
          return
        }
        setJiraIssues(issues)
        setJiraLoading(false)
      })
      .catch((err) => {
        if (cancelled) {
          return
        }
        setJiraError(err instanceof Error ? err.message : 'Failed to load Jira issues.')
        setJiraLoading(false)
      })

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    taskSource,
    jiraStatus.connected,
    selectedJiraSiteId,
    appliedJiraSearch,
    activeJiraPreset,
    jiraRefreshNonce,
    taskResumeApplied
  ])

  useEffect(() => {
    if (!taskResumeApplied || taskSource !== 'jira') {
      return
    }
    if (!jiraStatus.connected || displayedJiraIssues.length === 0) {
      if (selectedJiraIssueKey !== null) {
        setSelectedJiraIssueKey(null)
      }
      if (selectedJiraIssueFallback !== null) {
        setSelectedJiraIssueFallback(null)
      }
      return
    }
    if (
      selectedJiraIssueKey &&
      !displayedJiraIssues.some((issue) => issue.key === selectedJiraIssueKey)
    ) {
      setSelectedJiraIssueKey(null)
      setSelectedJiraIssueFallback(null)
    }
  }, [
    displayedJiraIssues,
    jiraStatus.connected,
    selectedJiraIssueFallback,
    selectedJiraIssueKey,
    taskResumeApplied,
    taskSource
  ])

  // Why: for Linear issues the "Use" flow opens the composer with the issue
  // info adapted to the LinkedWorkItemSummary shape. Linear identifiers are
  // strings (e.g. "ENG-123") so we use 0 as a placeholder number since the
  // provider-generic work item shape still expects numeric issue metadata.
  const openComposerForLinearItem = useCallback(
    (issue: LinearIssue, renderedText?: string): void => {
      const linkedWorkItem = buildLinearIssueLinkedWorkItem(issue, renderedText)
      openModal('new-workspace-composer', {
        linkedWorkItem,
        prefilledName: getLinearIssueWorkspaceName(issue),
        telemetrySource: 'sidebar'
      })
    },
    [openModal]
  )

  const handleUseLinearItem = useCallback(
    (issue: LinearIssue, renderedText?: string): void => {
      // Why: same rationale as handleUseWorkItem — open the New Workspace
      // dialog pre-filled rather than yolo-creating the worktree, so the
      // user can confirm name / agent / setup before the worktree lands in
      // the sidebar. Telemetry attribution flows via openComposerForLinearItem.
      openComposerForLinearItem(issue, renderedText)
    },
    [openComposerForLinearItem]
  )

  const handleLinearWorkspaceChange = useCallback(
    (workspaceId: LinearWorkspaceSelection): void => {
      clearSelectedLinearIssue()
      setSelectedLinearProject(null)
      setSelectedLinearProjectDetail(null)
      setSelectedLinearCustomView(null)
      setLinearProjectParentView(null)
      setLinearProjectTab('overview')
      setLinearProjectsResult({ items: [] })
      setLinearCustomViewsResult({ items: [] })
      setLinearProjectIssuesResult({ items: [] })
      setLinearCustomViewIssuesResult({ items: [] })
      setLinearCustomViewProjectsResult({ items: [] })
      setLinearProjectDetailError(null)
      setLinearProjectsError(null)
      setLinearCustomViewsError(null)
      setLinearCustomViewContentsError(null)
      setTaskResumeState({
        linearMode,
        linearContext: undefined
      })
      linearContextResumeAttemptedRef.current = false
      setLinearIssues([])
      setLinearError(null)
      setLinearLoading(true)
      void selectLinearWorkspace(workspaceId)
        .then(() => {
          setLinearTeamRefreshNonce((n) => n + 1)
        })
        .catch(() => {
          setLinearLoading(false)
          toast.error('Failed to switch Linear workspace.')
        })
    },
    [clearSelectedLinearIssue, linearMode, selectLinearWorkspace, setTaskResumeState]
  )

  const handleLinearTeamSelectionChange = useCallback(
    (next: ReadonlySet<string>, persisted: string[] | null): void => {
      setLinearTeamSelection(new Set(next))
      void updateSettings({ defaultLinearTeamSelection: persisted }).catch(() => {
        toast.error('Failed to save team selection.')
      })
    },
    [updateSettings]
  )

  const handleLinearScopeOpen = useCallback((): void => {
    void checkLinearConnection(true)
    void listLinearTeams(selectedLinearWorkspaceId, { force: true })
      .then((teams) => {
        setAvailableTeams(teams)
      })
      .catch(() => {
        console.warn('[TaskPage] Failed to refresh Linear teams')
      })
  }, [checkLinearConnection, listLinearTeams, selectedLinearWorkspaceId])

  const handleLinearAccessConnected = useCallback((): void => {
    setLinearTeamRefreshNonce((n) => n + 1)
    setLinearRefreshNonce((n) => n + 1)
  }, [])

  const openComposerForJiraItem = useCallback(
    (issue: JiraIssue): void => {
      const linkedWorkItem: LinkedWorkItemSummary = {
        type: 'issue',
        provider: 'jira',
        number: 0,
        title: `${issue.key} ${issue.title}`,
        url: issue.url,
        jiraIdentifier: issue.key
      }
      openModal('new-workspace-composer', {
        linkedWorkItem,
        prefilledName: getJiraIssueWorkspaceSeed(issue),
        telemetrySource: 'sidebar'
      })
    },
    [openModal]
  )

  const handleUseJiraItem = useCallback(
    (issue: JiraIssue): void => {
      openComposerForJiraItem(issue)
    },
    [openComposerForJiraItem]
  )

  const handleJiraConnect = useCallback(async (): Promise<void> => {
    const siteUrl = jiraSiteUrlDraft.trim()
    const email = jiraEmailDraft.trim()
    const apiToken = jiraApiTokenDraft.trim()
    if (!siteUrl || !email || !apiToken) {
      return
    }
    setJiraConnectState('connecting')
    setJiraConnectError(null)
    try {
      const result = await connectJira({ siteUrl, email, apiToken })
      if (result.ok) {
        setJiraSiteUrlDraft('')
        setJiraEmailDraft('')
        setJiraApiTokenDraft('')
        setJiraConnectState('idle')
        setJiraConnectOpen(false)
      } else {
        setJiraConnectState('error')
        setJiraConnectError(result.error)
      }
    } catch (error) {
      setJiraConnectState('error')
      setJiraConnectError(error instanceof Error ? error.message : 'Connection failed')
    }
  }, [connectJira, jiraApiTokenDraft, jiraEmailDraft, jiraSiteUrlDraft])

  return (
    <div className="relative flex h-full min-h-0 flex-1 overflow-hidden bg-background text-foreground">
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        {/* Why: pt-1.5 vertically centers this row's 32px icon cluster (X +
            source toggles) with the sidebar's "Tasks" nav row. Sidebar Tasks
            center sits 22px below the titlebar (pt-2 + py-1.5 + half size-4
            icon). Matching that here needs 6px top padding above the 32px
            cluster (6 + 16 = 22). The previous pt-3 placed the cluster 6px
            too low, breaking the visual band across the top chrome. */}
        <div className="mx-auto flex min-h-0 min-w-0 w-full flex-1 flex-col px-5 pt-1.5 pb-5 md:px-8 md:pt-1.5 md:pb-7">
          <div
            className={cn(
              'flex-none flex flex-col gap-3',
              // Why: GitHub detail views (PR + Issue) fill the entire right
              // pane — the list filter row above them is not relevant and
              // would visually duplicate the detail page's own breadcrumb.
              taskSource === 'github' && dialogWorkItem && 'hidden'
            )}
          >
            <section className="flex flex-col gap-3">
              <div className="flex flex-col gap-3">
                <div className="flex items-center justify-between gap-2">
                  <div
                    className="flex min-w-0 flex-wrap items-center gap-2"
                    data-contextual-tour-target="tasks-source-filters"
                  >
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
                    {visibleSourceOptions.map((source) => {
                      const active = taskSource === source.id
                      return (
                        <Tooltip key={source.id}>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              disabled={source.disabled}
                              onClick={() => {
                                taskSourceManuallyChangedRef.current = true
                                openTaskPage({ taskSource: source.id })
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
                      <LinearScopeSelector
                        workspaces={linearWorkspaces}
                        selectedWorkspaceId={selectedLinearWorkspaceId}
                        teams={linearTeamOptions}
                        selectedTeamIds={linearTeamSelection}
                        teamSelectionIsStickyAll={defaultLinearTeamSelection == null}
                        onWorkspaceChange={handleLinearWorkspaceChange}
                        onTeamSelectionChange={handleLinearTeamSelectionChange}
                        onAddTeamAccess={() => setLinearConnectOpen(true)}
                        onOpen={handleLinearScopeOpen}
                      />
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            type="button"
                            variant="outline"
                            size="icon-sm"
                            onClick={() => {
                              if (!selectedLinearTeamForExternalLink?.url) {
                                return
                              }
                              void window.api.shell.openUrl(selectedLinearTeamForExternalLink.url)
                            }}
                            disabled={!selectedLinearTeamForExternalLink}
                            aria-label={
                              selectedLinearTeamForExternalLink
                                ? `Open ${selectedLinearTeamForExternalLink.name} in Linear`
                                : 'Select one Linear team to open in Linear'
                            }
                            className="h-8 w-8 rounded-md border-border/50 bg-muted/50 text-foreground shadow-sm transition hover:bg-muted/50"
                          >
                            <ExternalLink className="size-3.5" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent side="bottom" sideOffset={6}>
                          {selectedLinearTeamForExternalLink
                            ? `Open ${selectedLinearTeamForExternalLink.name} in Linear`
                            : 'Select one team to open in Linear'}
                        </TooltipContent>
                      </Tooltip>
                    </div>
                  ) : null}
                  {taskSource === 'jira' && jiraStatus.connected ? (
                    <div className="flex items-center gap-2">
                      {jiraSites.length > 1 ? (
                        <Select
                          value={selectedJiraSiteId ?? undefined}
                          onValueChange={(value) => {
                            setSelectedJiraIssueKey(null)
                            setSelectedJiraIssueFallback(null)
                            setJiraIssues([])
                            setJiraError(null)
                            setJiraLoading(true)
                            void selectJiraSite(value).catch(() => {
                              toast.error('Failed to switch Jira site.')
                            })
                          }}
                        >
                          <SelectTrigger className="h-8 w-[220px] rounded-md border-border/50 bg-muted/50 text-xs font-medium shadow-sm">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="all">All Jira sites</SelectItem>
                            {jiraSites.map((site) => (
                              <SelectItem key={site.id} value={site.id}>
                                {site.displayName}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : null}
                    </div>
                  ) : null}
                </div>

                {taskSource === 'github' ? (
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    {projectModeVisible ? (
                      <div className="flex items-center gap-1 text-xs">
                        {GITHUB_MODE_BUTTONS.map((mode) => {
                          const active =
                            mode.id === 'project'
                              ? githubMode === 'project'
                              : githubMode === 'items' && activeGithubTaskKind === mode.id
                          return (
                            <button
                              key={mode.id}
                              type="button"
                              onClick={() => {
                                if (mode.id === 'project') {
                                  setGithubMode('project')
                                  setTaskResumeState({ githubMode: 'project' })
                                  return
                                }
                                setGithubMode('items')
                                setTaskResumeState({ githubMode: 'items' })
                                handleSelectGithubTaskKind(mode.id)
                              }}
                              className={cn(
                                'rounded-md border px-2 py-1 text-xs transition',
                                active
                                  ? 'border-border/50 bg-foreground/90 text-background'
                                  : 'border-border/50 bg-transparent text-foreground hover:bg-muted/50'
                              )}
                            >
                              {mode.label}
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
                      <>
                        <div className="min-w-0 max-w-[220px] shrink-0">
                          <RepoMultiCombobox
                            repos={eligibleRepos}
                            selected={repoSelection}
                            onChange={(next) => {
                              setRepoSelection(next)
                              void updateSettings({ defaultRepoSelection: [...next] }).catch(() => {
                                toast.error('Failed to save project selection.')
                              })
                            }}
                            onSelectAll={() => {
                              const allIds = new Set(eligibleRepos.map((r) => r.id))
                              setRepoSelection(allIds)
                              void updateSettings({ defaultRepoSelection: null }).catch(() => {
                                toast.error('Failed to save project selection.')
                              })
                            }}
                            triggerClassName="h-8 w-auto max-w-[220px] rounded-md border border-border/50 bg-muted/50 px-2 text-xs font-medium shadow-sm transition hover:bg-muted/50 focus:ring-2 focus:ring-ring/20 focus:outline-none"
                          />
                        </div>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              type="button"
                              variant="outline"
                              size="icon-sm"
                              onClick={() => {
                                if (!selectedGitHubRepoExternalLink?.url) {
                                  return
                                }
                                void window.api.shell.openUrl(selectedGitHubRepoExternalLink.url)
                              }}
                              aria-label={
                                selectedGitHubRepoExternalLink
                                  ? `Open ${selectedGitHubRepoExternalLink.label} in GitHub`
                                  : 'Select one GitHub project to open in GitHub'
                              }
                              className="h-8 w-8 rounded-md border-border/50 bg-muted/50 text-foreground shadow-sm transition hover:bg-muted/50"
                            >
                              <ExternalLink className="size-3.5" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent side="bottom" sideOffset={6}>
                            {selectedGitHubRepoExternalLink
                              ? `Open ${selectedGitHubRepoExternalLink.label} in GitHub`
                              : 'Select one project to open in GitHub'}
                          </TooltipContent>
                        </Tooltip>
                      </>
                    )}
                  </div>
                ) : null}

                {taskSource === 'github' && githubMode === 'items' ? (
                  <div
                    className="min-w-0 rounded-md rounded-b-none border border-border/50 bg-muted/50 p-3 shadow-sm"
                    data-contextual-tour-target="tasks-search-presets"
                  >
                    <div className="mb-3 flex flex-wrap gap-2">
                      {getGitHubTaskKindPresets(activeGithubTaskKind).map((option) => {
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
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <PRFilterDropdowns
                        parsed={parseTaskQuery(taskSearchInput)}
                        kind={activeGithubTaskKind}
                        authorLogins={loadedGitHubAuthorLogins}
                        primarySlug={primaryGithubFilterSlug}
                        settings={settings}
                        onChange={(change) => applyPRFilterChange(change)}
                      />
                      <div className="relative min-w-0 flex-1 basis-64">
                        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                        <Input
                          ref={taskSearchInputRef}
                          data-github-items-search-input
                          value={taskSearchInput}
                          onChange={handleTaskSearchChange}
                          onKeyDown={handleTaskSearchKeyDown}
                          placeholder={
                            activeGithubTaskKind === 'prs'
                              ? 'Search GitHub PRs...'
                              : 'Search GitHub issues...'
                          }
                          className="h-8 rounded-md border-border/50 bg-background pl-8 pr-8 text-xs"
                        />
                        {taskSearchInput || appliedTaskSearch ? (
                          <button
                            type="button"
                            aria-label="Clear search"
                            onClick={handleResetGithubTaskSearch}
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground transition hover:text-foreground"
                          >
                            <X className="size-4" />
                          </button>
                        ) : null}
                      </div>
                      <div
                        className="flex shrink-0 items-center gap-2"
                        data-contextual-tour-target="tasks-actions"
                      >
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="outline"
                              size="icon"
                              onClick={() => {
                                setNewIssueTitle('')
                                setNewIssueBody('')
                                setNewIssueLabels([])
                                setNewIssueAssignees([])
                                setNewIssueRepoId(primaryRepo?.id ?? null)
                                setNewIssueOpen(true)
                              }}
                              disabled={!newIssueTargetRepo}
                              aria-label="New GitHub issue"
                              className="size-8 border-border/50 bg-transparent hover:bg-muted/50 backdrop-blur-md supports-[backdrop-filter]:bg-transparent"
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
                              onClick={handleRefreshGithubTasks}
                              disabled={githubTasksBusy}
                              aria-busy={githubTasksBusy}
                              aria-label={
                                githubTasksBusy ? 'Refreshing GitHub work' : 'Refresh GitHub work'
                              }
                              className="size-8 cursor-pointer border-border/50 bg-transparent hover:bg-muted/50 backdrop-blur-md disabled:pointer-events-auto disabled:cursor-wait supports-[backdrop-filter]:bg-transparent"
                            >
                              {githubTasksBusy ? (
                                <LoaderCircle className="size-4 animate-spin" />
                              ) : (
                                <RefreshCw className="size-4" />
                              )}
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent side="bottom" sideOffset={6}>
                            {githubTasksBusy ? 'Refreshing GitHub work…' : 'Refresh GitHub work'}
                          </TooltipContent>
                        </Tooltip>
                      </div>
                    </div>

                    {(() => {
                      // Why: unify feature 1 (indicator) and feature 2 (selector)
                      // into a single chip per repo. Rendering both separately
                      // produced visually redundant output — two local-repo
                      // badge labels, duplicate slugs. The selector's active pill
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
                            const showRepoBadgeLabel = selectedRepos.length > 1 && repo
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
                                    showRepoBadgeLabel && repo
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
                                {showRepoBadgeLabel ? (
                                  <RepoBadgeLabel
                                    name={repo.displayName}
                                    color={repo.badgeColor}
                                    badgeClassName="size-1.5"
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
                  <div
                    className="min-w-0 rounded-md rounded-b-none border border-border/50 bg-muted/50 p-3 shadow-sm"
                    data-contextual-tour-target="tasks-search-presets"
                  >
                    <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
                      <div
                        className="flex items-center gap-1 text-xs"
                        role="group"
                        aria-label="Linear task mode"
                      >
                        {LINEAR_MODE_OPTIONS.map((mode) => {
                          const active = linearMode === mode.id
                          return (
                            <button
                              key={mode.id}
                              type="button"
                              aria-pressed={active}
                              onClick={() => selectLinearMode(mode.id)}
                              className={cn(
                                'rounded-md border px-2 py-1 text-xs transition',
                                active
                                  ? 'border-border/50 bg-foreground/90 text-background'
                                  : 'border-border/50 bg-transparent text-foreground hover:bg-muted/50'
                              )}
                            >
                              {mode.label}
                            </button>
                          )
                        })}
                      </div>
                      <div
                        className="flex shrink-0 items-center gap-2"
                        data-contextual-tour-target="tasks-actions"
                      >
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="outline"
                              size="icon"
                              onClick={() => {
                                setNewLinearIssueTitle('')
                                setNewLinearIssueBody('')
                                const projectTeamId =
                                  selectedLinearProject?.teams?.[0]?.id ??
                                  availableTeams.find(
                                    (team) =>
                                      team.workspaceId === selectedLinearProject?.workspaceId
                                  )?.id
                                setNewLinearIssueTeamId(
                                  projectTeamId ?? availableTeams[0]?.id ?? null
                                )
                                setNewLinearIssueProjectId(selectedLinearProject?.id ?? null)
                                setNewLinearIssueOpen(true)
                              }}
                              disabled={availableTeams.length === 0}
                              aria-label="New Linear issue"
                              className="size-8 border-border/50 bg-transparent hover:bg-muted/50 backdrop-blur-md supports-[backdrop-filter]:bg-transparent"
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
                              disabled={
                                linearMode === 'issues'
                                  ? linearLoading
                                  : linearMode === 'projects'
                                    ? linearProjectsLoading || linearProjectDetailLoading
                                    : linearCustomViewsLoading || linearCustomViewContentsLoading
                              }
                              aria-label="Refresh Linear"
                              className="size-8 border-border/50 bg-transparent hover:bg-muted/50 backdrop-blur-md supports-[backdrop-filter]:bg-transparent"
                            >
                              {linearMode === 'issues' && linearLoading ? (
                                <LoaderCircle className="size-4 animate-spin" />
                              ) : linearMode === 'projects' &&
                                (linearProjectsLoading || linearProjectDetailLoading) ? (
                                <LoaderCircle className="size-4 animate-spin" />
                              ) : linearMode === 'views' &&
                                (linearCustomViewsLoading || linearCustomViewContentsLoading) ? (
                                <LoaderCircle className="size-4 animate-spin" />
                              ) : (
                                <RefreshCw className="size-4" />
                              )}
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent side="bottom" sideOffset={6}>
                            Refresh Linear
                          </TooltipContent>
                        </Tooltip>
                      </div>
                    </div>

                    {linearMode === 'issues' ? (
                      <div className="mt-3 flex min-w-0 items-center gap-3">
                        <div className="relative min-w-0 flex-1 basis-64">
                          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                          <Input
                            value={linearSearchInput}
                            onChange={(e) => setLinearSearchInput(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                if (
                                  shouldSuppressEnterSubmit(
                                    {
                                      isComposing: e.nativeEvent.isComposing,
                                      shiftKey: e.shiftKey
                                    },
                                    false
                                  )
                                ) {
                                  return
                                }
                                e.preventDefault()
                                const trimmed = linearSearchInput.trim()
                                setLinearSearchInput(trimmed)
                                setAppliedLinearSearch(trimmed)
                                setTaskResumeState({ linearQuery: trimmed, linearMode: 'issues' })
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
                                setTaskResumeState({ linearQuery: '', linearMode: 'issues' })
                                setLinearRefreshNonce((n) => n + 1)
                              }}
                              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground transition hover:text-foreground"
                            >
                              <X className="size-4" />
                            </button>
                          ) : null}
                        </div>
                      </div>
                    ) : linearMode === 'projects' && !selectedLinearProject ? (
                      <div className="mt-3 flex min-w-0 items-center gap-3">
                        <div className="relative min-w-0 flex-1 basis-64">
                          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                          <Input
                            value={linearProjectSearchInput}
                            onChange={(e) => setLinearProjectSearchInput(e.target.value)}
                            placeholder="Search Linear projects..."
                            className="h-8 rounded-md border-border/50 bg-background pl-8 pr-8 text-xs"
                          />
                          {linearProjectSearchInput ? (
                            <button
                              type="button"
                              aria-label="Clear search"
                              onClick={() => {
                                setLinearProjectSearchInput('')
                                setAppliedLinearProjectSearch('')
                                setLinearRefreshNonce((n) => n + 1)
                              }}
                              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground transition hover:text-foreground"
                            >
                              <X className="size-4" />
                            </button>
                          ) : null}
                        </div>
                      </div>
                    ) : linearMode === 'views' && !selectedLinearCustomView ? (
                      <div
                        className="mt-3 flex min-w-0 flex-wrap items-center gap-2"
                        role="group"
                        aria-label="Linear view type"
                      >
                        {LINEAR_CUSTOM_VIEW_MODEL_OPTIONS.map((option) => {
                          const active = option.id === linearCustomViewModel
                          return (
                            <button
                              key={option.id}
                              type="button"
                              aria-pressed={active}
                              onClick={() => {
                                setSelectedLinearCustomView(null)
                                setLinearCustomViewModel(option.id)
                                setLinearCustomViewsResult({ items: [] })
                                setLinearCustomViewsError(null)
                                setLinearRefreshNonce((n) => n + 1)
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
                    ) : null}
                  </div>
                ) : taskSource === 'jira' && jiraStatus.connected ? (
                  <div className="rounded-md rounded-b-none border border-border/50 bg-muted/50 p-3 shadow-sm">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="flex flex-wrap gap-2">
                        {JIRA_PRESETS.map((preset) => {
                          const active = !jiraSearchInput && activeJiraPreset === preset.id
                          return (
                            <button
                              key={preset.id}
                              type="button"
                              onClick={() => {
                                setJiraSearchInput('')
                                setAppliedJiraSearch('')
                                setActiveJiraPreset(preset.id)
                                setTaskResumeState({ jiraPreset: preset.id, jiraQuery: '' })
                                setJiraRefreshNonce((n) => n + 1)
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
                                setNewJiraIssueTitle('')
                                setNewJiraIssueBody('')
                                setNewJiraIssueProjectId(
                                  sortedAvailableJiraProjects[0]
                                    ? getJiraProjectSelectionKey(sortedAvailableJiraProjects[0])
                                    : null
                                )
                                setNewJiraIssueProjectQuery('')
                                setNewJiraIssueProjectCommandValue('')
                                setNewJiraIssueTypeId(null)
                                setNewJiraIssueOpen(true)
                              }}
                              disabled={
                                sortedAvailableJiraProjects.length === 0 || jiraProjectsLoading
                              }
                              aria-label="New Jira issue"
                              className="border-border/50 bg-transparent hover:bg-muted/50 backdrop-blur-md supports-[backdrop-filter]:bg-transparent"
                            >
                              {jiraProjectsLoading ? (
                                <LoaderCircle className="size-4 animate-spin" />
                              ) : (
                                <Plus className="size-4" />
                              )}
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent side="bottom" sideOffset={6}>
                            New Jira issue
                          </TooltipContent>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="outline"
                              size="icon"
                              onClick={() => setJiraRefreshNonce((n) => n + 1)}
                              disabled={jiraLoading}
                              aria-label="Refresh Jira issues"
                              className="border-border/50 bg-transparent hover:bg-muted/50 backdrop-blur-md supports-[backdrop-filter]:bg-transparent"
                            >
                              {jiraLoading ? (
                                <LoaderCircle className="size-4 animate-spin" />
                              ) : (
                                <RefreshCw className="size-4" />
                              )}
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent side="bottom" sideOffset={6}>
                            Refresh Jira issues
                          </TooltipContent>
                        </Tooltip>
                      </div>
                    </div>
                    <div className="mt-3 flex items-center gap-3">
                      <div className="relative min-w-[320px] flex-1">
                        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                        <Input
                          value={jiraSearchInput}
                          onChange={(e) => setJiraSearchInput(e.target.value)}
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
                              const trimmed = jiraSearchInput.trim()
                              setJiraSearchInput(trimmed)
                              setAppliedJiraSearch(trimmed)
                              setTaskResumeState({ jiraQuery: trimmed })
                              setJiraRefreshNonce((n) => n + 1)
                            }
                          }}
                          placeholder="Jira JQL, e.g. project = ABC AND statusCategory != Done"
                          className="h-8 rounded-md border-border/50 bg-background pl-8 pr-8 text-xs"
                        />
                        {jiraSearchInput ? (
                          <button
                            type="button"
                            aria-label="Clear search"
                            onClick={() => {
                              setJiraSearchInput('')
                              setAppliedJiraSearch('')
                              setTaskResumeState({ jiraQuery: '' })
                              setJiraRefreshNonce((n) => n + 1)
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
                  <>
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <div className="flex items-center gap-1 text-xs">
                        {(['issues', 'mrs', 'todos'] as const).map((view) => {
                          const active = gitlabView === view
                          const label =
                            view === 'issues' ? 'Issues' : view === 'mrs' ? 'MRs' : 'My Todos'
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
                      <div className="min-w-0 w-full sm:w-[200px]">
                        <RepoMultiCombobox
                          repos={eligibleRepos}
                          selected={repoSelection}
                          onChange={(next) => {
                            setRepoSelection(next)
                            void updateSettings({ defaultRepoSelection: [...next] }).catch(() => {
                              toast.error('Failed to save project selection.')
                            })
                          }}
                          onSelectAll={() => {
                            const allIds = new Set(eligibleRepos.map((r) => r.id))
                            setRepoSelection(allIds)
                            void updateSettings({ defaultRepoSelection: null }).catch(() => {
                              toast.error('Failed to save project selection.')
                            })
                          }}
                          triggerClassName="h-8 w-full rounded-md border border-border/50 bg-muted/50 px-2 text-xs font-medium shadow-sm transition hover:bg-muted/50 focus:ring-2 focus:ring-ring/20 focus:outline-none"
                        />
                      </div>
                    </div>
                    <div
                      className="min-w-0 rounded-md rounded-b-none border border-border/50 bg-muted/50 p-3 shadow-sm"
                      data-contextual-tour-target="tasks-search-presets"
                    >
                      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                          <div className="flex flex-wrap gap-2">
                            {gitlabView === 'issues' || gitlabView === 'mrs'
                              ? (gitlabView === 'issues'
                                  ? GITLAB_ISSUE_FILTERS
                                  : GITLAB_MR_FILTERS
                                ).map(({ id, label }) => {
                                  const active = activeGitlabFilter === id
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
                        </div>
                        <div
                          className="flex shrink-0 items-center gap-2"
                          data-contextual-tour-target="tasks-actions"
                        >
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="outline"
                                size="icon"
                                onClick={() => setGitlabRefreshNonce((n) => n + 1)}
                                disabled={gitlabLoading || gitlabTodosLoading}
                                aria-label={
                                  gitlabView === 'todos'
                                    ? 'Refresh My Todos'
                                    : 'Refresh GitLab work items'
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
                              {gitlabView === 'todos'
                                ? 'Refresh My Todos'
                                : 'Refresh GitLab work items'}
                            </TooltipContent>
                          </Tooltip>
                        </div>
                      </div>
                    </div>
                  </>
                ) : null}
              </div>
            </section>
          </div>

          {taskSource === 'github' && dialogWorkItem ? (
            dialogWorkItem.type === 'pr' ? (
              <PullRequestPage
                workItem={dialogWorkItem}
                initialTab={dialogInitialTab}
                repoPath={dialogRepoPath}
                repoId={dialogWorkItem.repoId}
                backLabel="Pull requests"
                onUse={(item) => {
                  setDialogWorkItem(null)
                  handleUseWorkItem(item)
                }}
                onReviewRequestsChange={handleDialogReviewRequestsChange}
                onClose={closeTaskDetailPage}
              />
            ) : (
              <GitHubItemDialog
                workItem={dialogWorkItem}
                initialTab={dialogInitialTab}
                repoPath={dialogRepoPath}
                repoId={dialogWorkItem.repoId}
                variant="page"
                backLabel="GitHub list"
                onUse={(item) => {
                  setDialogWorkItem(null)
                  handleUseWorkItem(item)
                }}
                onReviewRequestsChange={handleDialogReviewRequestsChange}
                onClose={closeTaskDetailPage}
              />
            )
          ) : taskSource === 'github' && githubMode === 'project' ? (
            <div className="mt-3 flex min-h-0 min-w-0 max-h-full flex-col overflow-hidden rounded-md border border-border/50 bg-muted/50 shadow-sm">
              <ProjectViewWrapper />
            </div>
          ) : taskSource === 'github' ? (
            <div className="flex min-h-0 min-w-0 max-h-full flex-col overflow-hidden rounded-md rounded-t-none border border-t-0 border-border/50 bg-muted/50 shadow-sm">
              <div
                className="min-h-0 flex-initial overflow-auto scrollbar-sleek scrollbar-sleek-lg"
                style={{ scrollbarGutter: 'stable' }}
              >
                <div
                  className={cn(
                    'sticky top-0 z-10 grid gap-2 border-b border-border/50 bg-muted/50 px-3 py-2 text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground',
                    githubTaskGridClass
                  )}
                >
                  <span className={GITHUB_TASK_STICKY_ID_HEADER_CLASS}>ID</span>
                  <span className={GITHUB_TASK_STICKY_TITLE_HEADER_CLASS}>Title / Context</span>
                  {activeGithubTaskKind === 'issues' ? <span>Assignees</span> : null}
                  {showPRManagementColumns ? (
                    <>
                      <span>Reviewers</span>
                      <span>Checks</span>
                      <span>Merge</span>
                    </>
                  ) : (
                    <span>Status</span>
                  )}
                  <span>Updated</span>
                  <span />
                </div>

                {tasksError ? (
                  <div className="border-b border-border px-4 py-4 text-sm text-destructive">
                    {tasksError}
                  </div>
                ) : null}

                {!tasksError && failedCount > 0 ? (
                  // Why: per-repo partial-failure signal — distinct from a hard
                  // IPC reject (tasksError). The two are mutually exclusive.
                  <div className="border-b border-border/50 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-200">
                    {failedCount} of {selectedRepos.length} projects failed to load
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

                {showGitHubTaskSkeletons ? (
                  // Why: render enough shimmer rows to fill a typical viewport
                  // so the table doesn't visibly grow when results land. A
                  // 3-row stub jumps to ~30 real rows; matching the steady-
                  // state height keeps layout stable across the load.
                  <div className="divide-y divide-border/50">
                    {Array.from({ length: 12 }).map((_, i) => (
                      <div key={i} className={cn('grid gap-2 px-3 py-2', githubTaskGridClass)}>
                        <div className={GITHUB_TASK_STICKY_ID_CELL_CLASS}>
                          <div className="h-7 w-16 animate-pulse rounded-lg bg-muted/70" />
                        </div>
                        <div className={GITHUB_TASK_STICKY_TITLE_CELL_CLASS}>
                          <div className="h-4 w-3/5 animate-pulse rounded bg-muted/70" />
                          <div className="mt-2 h-3 w-2/5 animate-pulse rounded bg-muted/60" />
                        </div>
                        {!showPRManagementColumns ? (
                          <div className="flex items-center">
                            <div className="h-3 w-24 animate-pulse rounded bg-muted/60" />
                          </div>
                        ) : null}
                        {showPRManagementColumns ? (
                          <>
                            <div className="flex items-center">
                              <div className="h-5 w-20 animate-pulse rounded-full bg-muted/70" />
                            </div>
                            <div className="flex items-center">
                              <div className="h-5 w-20 animate-pulse rounded-full bg-muted/70" />
                            </div>
                            <div className="flex items-center">
                              <div className="h-5 w-20 animate-pulse rounded-full bg-muted/70" />
                            </div>
                          </>
                        ) : (
                          <div className="flex items-center">
                            <div className="h-5 w-14 animate-pulse rounded-full bg-muted/70" />
                          </div>
                        )}
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
                {!showGitHubTaskSkeletons &&
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
                  {!showGitHubTaskSkeletons &&
                    filteredWorkItems.map((item) => {
                      const itemRepo = repoMap.get(item.repoId) ?? null
                      const attachedWorkspace = findGithubWorkItemWorkspaceAttachment(
                        allWorktrees,
                        item.repoId,
                        item.type,
                        item.number
                      )
                      const attachedWorkspaceLabel = attachedWorkspace
                        ? getGithubWorkItemWorkspaceAttachmentLabel(attachedWorkspace)
                        : null
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
                          onClick={() => openGitHubDetailPage(item)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault()
                              openGitHubDetailPage(item)
                            }
                          }}
                          className={cn(
                            'group/github-task-row grid cursor-pointer gap-2 px-3 py-2 text-left transition hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                            githubTaskGridClass
                          )}
                        >
                          <div className={GITHUB_TASK_STICKY_ID_CELL_CLASS}>
                            <span
                              className={cn(
                                'inline-flex items-center gap-1 rounded-md border border-border/50 bg-muted/40 px-1.5 py-0.5',
                                item.state === 'merged'
                                  ? 'text-purple-600 dark:text-purple-300'
                                  : item.state === 'closed'
                                    ? 'text-rose-600 dark:text-rose-300'
                                    : 'text-muted-foreground'
                              )}
                            >
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

                          <div className={GITHUB_TASK_STICKY_TITLE_CELL_CLASS}>
                            <div className="flex items-center gap-2">
                              <h3 className="truncate text-sm font-semibold text-foreground">
                                {item.title}
                              </h3>
                              {item.type === 'pr' && item.state === 'draft' ? (
                                <span className="shrink-0 rounded-full border border-slate-500/30 bg-slate-500/10 px-1.5 py-0 text-[10px] font-medium text-slate-600 dark:text-slate-300">
                                  Draft
                                </span>
                              ) : null}
                              {selectedRepos.length > 1 && itemRepo ? (
                                // Why: disambiguate rows when multiple repos are in
                                // the merged list — a single-repo view doesn't need it.
                                <RepoBadgeLabel
                                  name={itemRepo.displayName}
                                  color={itemRepo.badgeColor}
                                  badgeClassName="size-1.5"
                                  className="shrink-0 text-[11px] text-muted-foreground"
                                />
                              ) : null}
                            </div>
                            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
                              <span>{item.author ?? 'unknown author'}</span>
                              {selectedRepos.length === 1 && itemRepo ? (
                                <span>{itemRepo.displayName}</span>
                              ) : null}
                              {item.type === 'pr' && formatPRDelta(item) ? (
                                <span className="inline-flex items-center gap-1">
                                  <Files className="size-3" />
                                  {formatPRDelta(item)}
                                </span>
                              ) : null}
                              {attachedWorkspaceLabel ? (
                                <span className="inline-flex min-w-0 items-center gap-1">
                                  <FolderKanban className="size-3 shrink-0" />
                                  <span className="truncate">{attachedWorkspaceLabel}</span>
                                </span>
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

                          {!showPRManagementColumns ? (
                            <div className="min-w-0 flex items-center text-xs text-muted-foreground">
                              <GHAssigneesCell item={item} repo={itemRepo ?? null} />
                            </div>
                          ) : null}

                          {showPRManagementColumns ? (
                            <>
                              <div className="flex min-w-0 items-center">
                                <PRReviewCell item={item} repo={itemRepo ?? null} />
                              </div>

                              <div className="flex min-w-0 items-center">
                                <PRChecksCell
                                  item={item}
                                  onOpen={() => openGitHubDetailPage(item, 'checks')}
                                  onLoadChecks={() => ensurePRChecksLoaded(item)}
                                />
                              </div>

                              <div className="flex min-w-0 items-center">
                                <PRMergeCell
                                  item={item}
                                  repo={itemRepo ?? null}
                                  onRefresh={() => setTaskRefreshNonce((current) => current + 1)}
                                />
                              </div>
                            </>
                          ) : (
                            <div className="flex items-center">
                              <GHStatusCell item={item} repo={itemRepo ?? null} />
                            </div>
                          )}

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
                            {item.type === 'pr' ? (
                              <DropdownMenu modal={false}>
                                <ButtonGroup>
                                  <Button
                                    type="button"
                                    variant={attachedWorkspace ? 'default' : 'outline'}
                                    size="xs"
                                    data-contextual-tour-target="tasks-start-workspace"
                                    onClick={(event) => {
                                      event.stopPropagation()
                                      handleOpenOrUseGitHubWorkItem(item)
                                    }}
                                    className={cn(
                                      'min-w-[72px] gap-1 font-semibold',
                                      attachedWorkspace ? 'shadow-xs' : 'bg-background/80'
                                    )}
                                    aria-label={
                                      attachedWorkspace
                                        ? 'Resume workspace attached to PR'
                                        : 'Start workspace from PR'
                                    }
                                  >
                                    {attachedWorkspace ? 'Resume' : 'Start'}
                                    <ArrowRight className="size-3" />
                                  </Button>
                                  <DropdownMenuTrigger asChild>
                                    <Button
                                      type="button"
                                      variant={attachedWorkspace ? 'default' : 'outline'}
                                      size="icon-xs"
                                      onClick={(event) => event.stopPropagation()}
                                      className={cn(
                                        attachedWorkspace ? 'shadow-xs' : 'bg-background/80'
                                      )}
                                      aria-label="More PR actions"
                                    >
                                      <ChevronDown className="size-3" />
                                    </Button>
                                  </DropdownMenuTrigger>
                                </ButtonGroup>
                                <DropdownMenuContent
                                  align="end"
                                  onClick={(event) => event.stopPropagation()}
                                >
                                  {attachedWorkspace ? (
                                    <DropdownMenuItem onSelect={() => handleUseWorkItem(item)}>
                                      <Plus className="size-4" />
                                      Start new workspace
                                    </DropdownMenuItem>
                                  ) : null}
                                  <DropdownMenuItem
                                    onSelect={() => window.api.shell.openUrl(item.url)}
                                  >
                                    <ExternalLink className="size-4" />
                                    Open in browser
                                  </DropdownMenuItem>
                                </DropdownMenuContent>
                              </DropdownMenu>
                            ) : (
                              <button
                                type="button"
                                data-contextual-tour-target="tasks-start-workspace"
                                onClick={(event) => {
                                  event.stopPropagation()
                                  handleOpenOrUseGitHubWorkItem(item)
                                }}
                                aria-label={
                                  attachedWorkspace
                                    ? 'Open workspace attached to issue'
                                    : 'Start workspace from issue'
                                }
                                className="inline-flex items-center gap-1 rounded-md border border-border/50 bg-background/80 px-2 py-1 text-[11px] text-foreground transition hover:bg-muted/60"
                              >
                                {attachedWorkspace ? 'Open' : 'Start'}
                                <ArrowRight className="size-3" />
                              </button>
                            )}
                            {item.type !== 'pr' ? (
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
                                <DropdownMenuContent
                                  align="end"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  {attachedWorkspace ? (
                                    <DropdownMenuItem onSelect={() => handleUseWorkItem(item)}>
                                      <Plus className="size-4" />
                                      Start new workspace
                                    </DropdownMenuItem>
                                  ) : null}
                                  <DropdownMenuItem
                                    onSelect={() => window.api.shell.openUrl(item.url)}
                                  >
                                    <ExternalLink className="size-4" />
                                    Open in browser
                                  </DropdownMenuItem>
                                </DropdownMenuContent>
                              </DropdownMenu>
                            ) : null}
                          </div>
                        </div>
                      )
                    })}
                </div>
              </div>

              {/* Why: pagination sits outside the scroll container so it
                  remains pinned at the bottom of the panel rather than
                  hiding below the last row inside the scrolling region. */}
              {filteredWorkItems.length > 0 && !showGitHubTaskSkeletons && totalPages > 1 ? (
                <div className="flex-none border-t border-border/50 bg-muted/50">
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
                </div>
              ) : null}
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
                    {Array.from({ length: 12 }).map((_, i) => (
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
                      : 'Select a project so we can authenticate to GitLab.'}
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
                  // never flashes empty during the initial fetch. Row count is
                  // tuned to fill the viewport so the table doesn't visibly
                  // grow when real rows land.
                  <div className="divide-y divide-border/50">
                    {Array.from({ length: 12 }).map((_, i) => (
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
                {!gitlabLoading && displayedGitLabItems.length === 0 && !gitlabError ? (
                  <div className="px-4 py-12 text-center text-sm text-muted-foreground">
                    {primaryRepo
                      ? gitlabView === 'issues'
                        ? 'No GitLab issues match this filter.'
                        : gitlabView === 'mrs'
                          ? 'No GitLab MRs match this filter.'
                          : 'No GitLab work matches this filter.'
                      : 'Select a project to see GitLab work items.'}
                  </div>
                ) : null}
                <div className="divide-y divide-border/50">
                  {displayedGitLabItems.map((item) => (
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
                      <div className="flex items-center justify-end gap-1">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon-xs"
                              data-contextual-tour-target="tasks-start-workspace"
                              onClick={(event) => {
                                event.stopPropagation()
                                handleUseGitLabItem(item)
                              }}
                              aria-label={`Start workspace from ${item.type === 'mr' ? 'MR' : 'issue'} ${item.number}`}
                            >
                              <ArrowRight className="size-3.5" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent side="bottom" sideOffset={6}>
                            Start workspace
                          </TooltipContent>
                        </Tooltip>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation()
                            void window.api.shell.openUrl(item.url)
                          }}
                          aria-label="Open in GitLab"
                          className="text-muted-foreground hover:text-foreground"
                        >
                          <ExternalLink className="size-3.5" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ) : taskSource === 'jira' ? (
            !jiraStatusChecked ? (
              <div className="mt-4 flex items-center justify-center py-14">
                <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
              </div>
            ) : !jiraStatus.connected ? (
              <div className="mt-4 flex flex-col items-center justify-center rounded-md border border-border/50 bg-muted/50 px-6 py-14 text-center shadow-sm">
                <JiraIcon className="mb-4 size-8 text-muted-foreground/60" />
                <p className="text-base font-medium text-foreground">Connect your Jira site</p>
                <p className="mt-2 max-w-sm text-sm text-muted-foreground">
                  Browse, edit, create, and start work from Jira issues directly from here.
                </p>
                <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
                  <Button
                    onClick={() => {
                      setJiraSiteUrlDraft('')
                      setJiraEmailDraft('')
                      setJiraApiTokenDraft('')
                      setJiraConnectState('idle')
                      setJiraConnectError(null)
                      setJiraConnectOpen(true)
                    }}
                  >
                    Connect Jira
                  </Button>
                  <Button variant="outline" onClick={() => hideTaskSource('jira', 'Jira')}>
                    Hide Jira
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex min-h-0 max-h-full flex-col overflow-hidden rounded-md rounded-t-none border border-t-0 border-border/50 bg-background shadow-sm">
                <div className="flex h-10 flex-none items-center justify-between gap-3 border-b border-border/50 bg-muted/35 px-3">
                  <div className="min-w-0 text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                    Jira issues
                  </div>
                  <div className="shrink-0 text-[11px] text-muted-foreground">
                    {displayedJiraIssues.length} shown
                  </div>
                </div>

                <div className="grid h-8 flex-none grid-cols-[90px_minmax(0,1fr)_128px_92px_80px] items-center gap-3 border-b border-border/50 bg-muted/25 px-3 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground max-md:!hidden lg:grid-cols-[96px_minmax(0,1.25fr)_132px_120px_136px_96px_64px] xl:grid-cols-[104px_minmax(0,1.45fr)_144px_132px_160px_128px_72px]">
                  <span>Key</span>
                  <span>Issue</span>
                  <span>Status</span>
                  <span>Priority</span>
                  <span className="block max-lg:!hidden">Assignee</span>
                  <span>Updated</span>
                  <span />
                </div>

                <div
                  className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek"
                  style={{ scrollbarGutter: 'stable' }}
                >
                  {jiraError ? (
                    <div className="border-b border-border px-4 py-4 text-sm text-destructive">
                      {jiraError}
                    </div>
                  ) : null}

                  {jiraLoading && jiraIssues.length === 0 ? (
                    <div className="divide-y divide-border/50">
                      {Array.from({ length: 6 }).map((_, i) => (
                        <div key={i} className="px-3 py-3">
                          <div className="h-4 w-4/5 animate-pulse rounded bg-muted/70" />
                          <div className="mt-2 h-3 w-3/5 animate-pulse rounded bg-muted/60" />
                        </div>
                      ))}
                    </div>
                  ) : null}

                  {!jiraLoading && jiraIssues.length === 0 && !jiraError ? (
                    <div className="px-4 py-10 text-center">
                      <p className="text-sm font-medium text-foreground">No Jira issues found</p>
                      <p className="mt-2 text-sm text-muted-foreground">
                        {jiraSearchInput
                          ? 'Try a different JQL query.'
                          : 'No issues match the selected preset.'}
                      </p>
                    </div>
                  ) : null}

                  <div className="divide-y divide-border/50">
                    {displayedJiraIssues.map((issue) => {
                      const selected = issue.key === selectedJiraIssueKey
                      const labels = issue.labels.slice(0, 3)
                      const contextLabel =
                        selectedJiraSiteId === 'all' && issue.siteName
                          ? `${issue.siteName} / ${issue.project.key}`
                          : issue.project.key
                      return (
                        <div
                          key={`${issue.siteId ?? 'site'}:${issue.key}`}
                          role="button"
                          tabIndex={0}
                          aria-current={selected ? 'true' : undefined}
                          data-current={selected ? 'true' : undefined}
                          onClick={() => setSelectedJiraIssue(issue)}
                          onKeyDown={(e) => {
                            if (e.target !== e.currentTarget) {
                              return
                            }
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault()
                              setSelectedJiraIssue(issue)
                            }
                          }}
                          className={cn(
                            'group/row grid min-h-12 cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3 py-2 text-left transition hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring md:grid-cols-[90px_minmax(0,1fr)_128px_92px_80px] lg:grid-cols-[96px_minmax(0,1.25fr)_132px_120px_136px_96px_64px] xl:grid-cols-[104px_minmax(0,1.45fr)_144px_132px_160px_128px_72px]',
                            selected && 'bg-accent'
                          )}
                        >
                          <span className="block truncate font-mono text-[12px] text-muted-foreground max-md:!hidden">
                            {issue.key}
                          </span>

                          <div className="min-w-0">
                            <div className="flex min-w-0 items-center gap-2">
                              <span className="shrink-0 font-mono text-[11px] text-muted-foreground md:hidden">
                                {issue.key}
                              </span>
                              <h3 className="min-w-0 truncate text-[13px] font-medium text-foreground">
                                {issue.title}
                              </h3>
                            </div>
                            <div className="mt-1 flex min-w-0 items-center gap-1.5 md:!hidden">
                              <span
                                className={cn(
                                  'inline-flex min-w-0 items-center rounded-full border px-1.5 py-0.5 text-[11px] font-medium',
                                  getJiraStatusTone(issue.status.categoryKey)
                                )}
                              >
                                <span className="truncate">{issue.status.name}</span>
                              </span>
                              <span className="shrink-0 text-[11px] text-muted-foreground">
                                {issue.priority?.name ?? 'No priority'}
                              </span>
                              <span className="min-w-0 truncate text-[11px] text-muted-foreground">
                                {issue.assignee?.displayName ?? 'Unassigned'}
                              </span>
                            </div>
                            <div className="mt-1 flex min-w-0 items-center gap-1 max-lg:!hidden">
                              <span className="max-w-[160px] truncate text-[10px] text-muted-foreground xl:!hidden">
                                {contextLabel}
                              </span>
                              {labels.map((label) => (
                                <span
                                  key={label}
                                  className="max-w-[140px] truncate rounded-full border border-border/50 bg-muted/35 px-1.5 py-0.5 text-[10px] text-muted-foreground"
                                >
                                  {label}
                                </span>
                              ))}
                              {issue.labels.length > labels.length ? (
                                <span className="text-[10px] text-muted-foreground">
                                  +{issue.labels.length - labels.length}
                                </span>
                              ) : null}
                            </div>
                          </div>

                          <div className="flex min-w-0 max-md:!hidden">
                            <span
                              className={cn(
                                'inline-flex max-w-full items-center rounded-full border px-2 py-0.5 text-[11px] font-medium',
                                getJiraStatusTone(issue.status.categoryKey)
                              )}
                            >
                              <span className="truncate">{issue.status.name}</span>
                            </span>
                          </div>

                          <span className="block truncate text-[12px] text-muted-foreground max-md:!hidden">
                            {issue.priority?.name ?? 'No priority'}
                          </span>

                          <div className="flex min-w-0 items-center gap-2 text-[12px] text-muted-foreground max-lg:!hidden">
                            {issue.assignee?.avatarUrl ? (
                              <img
                                src={issue.assignee.avatarUrl}
                                alt={issue.assignee.displayName}
                                className="size-5 shrink-0 rounded-full"
                              />
                            ) : (
                              <span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-border/50 bg-muted/40 text-[10px]">
                                {issue.assignee?.displayName?.slice(0, 1) ?? '-'}
                              </span>
                            )}
                            <span className="truncate">
                              {issue.assignee?.displayName ?? 'Unassigned'}
                            </span>
                          </div>

                          <Tooltip>
                            <TooltipTrigger asChild>
                              <div className="block min-w-0 truncate text-[12px] text-muted-foreground max-md:!hidden">
                                {formatRelativeTime(issue.updatedAt)}
                              </div>
                            </TooltipTrigger>
                            <TooltipContent side="bottom" sideOffset={6}>
                              {new Date(issue.updatedAt).toLocaleString()}
                            </TooltipContent>
                          </Tooltip>

                          <div className="flex shrink-0 items-center justify-end gap-1 md:opacity-0 md:transition-opacity md:group-hover/row:opacity-100 md:group-focus-within/row:opacity-100">
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon-xs"
                                  onClick={(event) => {
                                    event.stopPropagation()
                                    handleUseJiraItem(issue)
                                  }}
                                  aria-label={`Start workspace from ${issue.key}`}
                                >
                                  <ArrowRight className="size-3.5" />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent side="bottom" sideOffset={6}>
                                Start workspace
                              </TooltipContent>
                            </Tooltip>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon-xs"
                                  onClick={(event) => {
                                    event.stopPropagation()
                                    window.api.shell.openUrl(issue.url)
                                  }}
                                  aria-label={`Open ${issue.key} in Jira`}
                                >
                                  <ExternalLink className="size-3.5" />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent side="bottom" sideOffset={6}>
                                Open in Jira
                              </TooltipContent>
                            </Tooltip>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
                <JiraIssueWorkspace
                  issue={selectedJiraIssue}
                  onUse={handleUseJiraItem}
                  onClose={() => setSelectedJiraIssue(null)}
                />
              </div>
            )
          ) : taskSource === 'linear' && selectedLinearIssue ? (
            <LinearIssueWorkspace
              issue={selectedLinearIssue}
              variant="page"
              backLabel={activeLinearIssueContextLabel ?? 'Linear list'}
              onUse={handleUseLinearItem}
              onOpenIssue={openRelatedLinearIssue}
              onClose={closeTaskDetailPage}
            />
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
                  setLinearConnectOpen(true)
                }}
              >
                Add Linear access
              </Button>
            </div>
          ) : selectedLinearProject && linearProjectTab === 'overview' ? (
            <div className="flex min-h-0 max-h-full flex-col overflow-hidden rounded-md rounded-t-none border border-t-0 border-border/50 bg-background shadow-sm">
              <LinearProjectOverview
                project={selectedLinearProjectDetail ?? selectedLinearProject}
                loading={linearProjectDetailLoading}
                error={linearProjectDetailError}
                onBack={() => {
                  if (linearProjectParentView) {
                    setSelectedLinearProject(null)
                    setSelectedLinearProjectDetail(null)
                    setLinearProjectTab('overview')
                    setLinearMode('views')
                    setSelectedLinearCustomView(linearProjectParentView)
                    setTaskResumeState(
                      linearProjectParentView.workspaceId
                        ? {
                            linearMode: 'views',
                            linearContext: {
                              kind: 'view',
                              id: linearProjectParentView.id,
                              workspaceId: linearProjectParentView.workspaceId,
                              model: linearProjectParentView.model
                            }
                          }
                        : {
                            linearMode: 'views',
                            linearContext: undefined
                          }
                    )
                    setLinearProjectParentView(null)
                    return
                  }
                  setSelectedLinearProject(null)
                  setSelectedLinearProjectDetail(null)
                  setLinearProjectParentView(null)
                  setLinearProjectTab('overview')
                  setTaskResumeState({ linearContext: undefined })
                }}
                onOpenProject={(project) => {
                  if (project.url) {
                    void window.api.shell.openUrl(project.url)
                  }
                }}
                onRefresh={() => setLinearRefreshNonce((n) => n + 1)}
                onOpenIssues={() => setLinearProjectTab('issues')}
              />
            </div>
          ) : linearMode === 'projects' && !selectedLinearProject ? (
            <div className="flex min-h-0 max-h-full flex-col overflow-hidden rounded-md rounded-t-none border border-t-0 border-border/50 bg-background shadow-sm">
              <div className="grid h-8 flex-none items-center gap-3 border-b border-border/50 bg-muted/25 px-3 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground grid-cols-[minmax(180px,1.5fr)_110px_100px_90px_120px_110px_80px_70px]">
                <span>Project</span>
                <span>Status</span>
                <span>Health</span>
                <span>Priority</span>
                <span>Lead</span>
                <span>Target</span>
                <span>Issues</span>
                <span />
              </div>
              <div className="min-h-0 flex-1 overflow-x-auto overflow-y-auto scrollbar-sleek">
                {linearProjectsError ? (
                  <div className="border-b border-border px-4 py-4 text-sm text-destructive">
                    {linearProjectsError}
                  </div>
                ) : null}
                <LinearProjectTable
                  projects={linearProjectsResult.items}
                  loading={linearProjectsLoading}
                  hasError={!!linearProjectsResult.errors?.length}
                  workspaceSelection={selectedLinearWorkspaceId}
                  onSelectProject={openLinearProjectContext}
                  onOpenProject={(project) => {
                    if (project.url) {
                      void window.api.shell.openUrl(project.url)
                    }
                  }}
                  onUseProjectIssues={(project) => {
                    openLinearProjectContext(project)
                    setLinearProjectTab('issues')
                  }}
                />
              </div>
              <LinearCollectionNotice
                errors={linearProjectsResult.errors}
                hasMore={linearProjectsResult.hasMore}
                count={linearProjectsResult.items.length}
                label="projects"
              />
            </div>
          ) : linearMode === 'views' && !selectedLinearCustomView ? (
            <div className="flex min-h-0 max-h-full flex-col overflow-hidden rounded-md rounded-t-none border border-t-0 border-border/50 bg-background shadow-sm">
              <div className="grid h-8 flex-none items-center gap-3 border-b border-border/50 bg-muted/25 px-3 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground grid-cols-[minmax(220px,1.5fr)_120px_120px_120px_130px_60px]">
                <span>View</span>
                <span>Model</span>
                <span>Visibility</span>
                <span>Owner</span>
                <span>Updated</span>
                <span />
              </div>
              <div className="min-h-0 flex-1 overflow-x-auto overflow-y-auto scrollbar-sleek">
                {linearCustomViewsError ? (
                  <div className="border-b border-border px-4 py-4 text-sm text-destructive">
                    {linearCustomViewsError}
                  </div>
                ) : null}
                <LinearCustomViewTable
                  views={linearCustomViewsResult.items}
                  model={linearCustomViewModel}
                  loading={linearCustomViewsLoading}
                  hasError={!!linearCustomViewsResult.errors?.length}
                  workspaceSelection={selectedLinearWorkspaceId}
                  onSelectView={openLinearCustomViewContext}
                  onOpenView={(view) => {
                    if (view.url) {
                      void window.api.shell.openUrl(view.url)
                    }
                  }}
                />
              </div>
              <LinearCollectionNotice
                errors={linearCustomViewsResult.errors}
                hasMore={linearCustomViewsResult.hasMore}
                count={linearCustomViewsResult.items.length}
                label={`${linearCustomViewModel} views`}
              />
            </div>
          ) : selectedLinearCustomView?.model === 'project' && !selectedLinearProject ? (
            <div className="flex min-h-0 max-h-full flex-col overflow-hidden rounded-md rounded-t-none border border-t-0 border-border/50 bg-background shadow-sm">
              <div className="flex h-10 flex-none items-center justify-between gap-3 border-b border-border/50 bg-muted/35 px-3">
                <div className="flex min-w-0 items-center gap-2">
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => {
                      setSelectedLinearCustomView(null)
                      setLinearProjectParentView(null)
                      setTaskResumeState({ linearContext: undefined })
                    }}
                    aria-label="Back to views"
                  >
                    <ChevronLeft className="size-3.5" />
                  </Button>
                  <div className="min-w-0">
                    <div className="truncate text-[13px] font-medium text-foreground">
                      {selectedLinearCustomView.name}
                    </div>
                    <div className="truncate text-[11px] text-muted-foreground">Linear / Views</div>
                  </div>
                </div>
                {selectedLinearCustomView.url ? (
                  <Button
                    variant="outline"
                    size="xs"
                    onClick={() => void window.api.shell.openUrl(selectedLinearCustomView.url!)}
                    className="gap-1 border-border/50 bg-background/70"
                  >
                    <ExternalLink className="size-3.5" />
                    Linear
                  </Button>
                ) : null}
              </div>
              <div className="min-h-0 flex-1 overflow-x-auto overflow-y-auto scrollbar-sleek">
                {linearCustomViewContentsError ? (
                  <div className="border-b border-border px-4 py-4 text-sm text-destructive">
                    {linearCustomViewContentsError}
                  </div>
                ) : null}
                <LinearProjectTable
                  projects={linearCustomViewProjectsResult.items}
                  loading={linearCustomViewContentsLoading}
                  hasError={!!linearCustomViewProjectsResult.errors?.length}
                  workspaceSelection={selectedLinearWorkspaceId}
                  onSelectProject={(project) =>
                    openLinearProjectContext(project, { parentView: selectedLinearCustomView })
                  }
                  onOpenProject={(project) => {
                    if (project.url) {
                      void window.api.shell.openUrl(project.url)
                    }
                  }}
                  onUseProjectIssues={(project) => {
                    openLinearProjectContext(project, { parentView: selectedLinearCustomView })
                    setLinearProjectTab('issues')
                  }}
                />
              </div>
              <LinearCollectionNotice
                errors={linearCustomViewProjectsResult.errors}
                hasMore={linearCustomViewProjectsResult.hasMore}
                count={linearCustomViewProjectsResult.items.length}
                label="projects"
              />
            </div>
          ) : (
            <div className="flex min-h-0 max-h-full flex-col overflow-hidden rounded-md rounded-t-none border border-t-0 border-border/50 bg-background shadow-sm">
              <div className="flex h-10 flex-none items-center justify-between gap-3 border-b border-border/50 bg-muted/35 px-3">
                <div className="flex min-w-0 items-center gap-2">
                  {activeLinearIssueContextLabel ? (
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => {
                        if (selectedLinearProject) {
                          setLinearProjectTab('overview')
                          return
                        }
                        setSelectedLinearCustomView(null)
                        setLinearProjectParentView(null)
                        setTaskResumeState({ linearContext: undefined })
                      }}
                      aria-label="Back"
                    >
                      <ChevronLeft className="size-3.5" />
                    </Button>
                  ) : null}
                  <div className="min-w-0 text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                    {activeLinearIssueContextLabel ?? 'Linear issues'}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <div
                    className="hidden items-center rounded-md border border-border/50 bg-background/70 p-0.5 md:flex"
                    aria-label="Linear view mode"
                  >
                    {LINEAR_VIEW_OPTIONS.map(({ id, label, Icon }) => {
                      const active = linearViewMode === id
                      return (
                        <Tooltip key={id}>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              onClick={() => setLinearViewMode(id)}
                              aria-label={`${label} view`}
                              aria-pressed={active}
                              className={cn(
                                'inline-flex size-6 items-center justify-center rounded text-muted-foreground transition hover:text-foreground',
                                active && 'bg-accent text-accent-foreground shadow-xs'
                              )}
                            >
                              <Icon className="size-3.5" />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="bottom" sideOffset={6}>
                            {label} view
                          </TooltipContent>
                        </Tooltip>
                      )
                    })}
                  </div>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="outline"
                        size="xs"
                        className="gap-1 border-border/50 bg-background/70 text-[11px]"
                      >
                        <SlidersHorizontal className="size-3.5" />
                        View
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-56">
                      <DropdownMenuLabel className="flex items-center gap-2">
                        <List className="size-3.5" />
                        View
                      </DropdownMenuLabel>
                      <DropdownMenuRadioGroup
                        value={linearViewMode}
                        onValueChange={(value) => setLinearViewMode(value as LinearViewMode)}
                      >
                        {LINEAR_VIEW_OPTIONS.map(({ id, label, Icon }) => (
                          <DropdownMenuRadioItem key={id} value={id}>
                            <Icon className="size-3.5" />
                            {label}
                          </DropdownMenuRadioItem>
                        ))}
                      </DropdownMenuRadioGroup>
                      <DropdownMenuSeparator />
                      <DropdownMenuLabel className="flex items-center gap-2">
                        <SlidersHorizontal className="size-3.5" />
                        Grouping
                      </DropdownMenuLabel>
                      <DropdownMenuRadioGroup
                        value={linearGroupBy}
                        onValueChange={(value) => setLinearGroupBy(value as LinearGroupBy)}
                      >
                        {LINEAR_GROUP_OPTIONS.map((option) => (
                          <DropdownMenuRadioItem key={option.id} value={option.id}>
                            {option.label}
                          </DropdownMenuRadioItem>
                        ))}
                      </DropdownMenuRadioGroup>
                      <DropdownMenuSeparator />
                      <DropdownMenuLabel className="flex items-center gap-2">
                        <ArrowDownUp className="size-3.5" />
                        Ordering
                      </DropdownMenuLabel>
                      <DropdownMenuRadioGroup
                        value={linearOrderBy}
                        onValueChange={(value) => setLinearOrderBy(value as LinearOrderBy)}
                      >
                        {LINEAR_ORDER_OPTIONS.map((option) => (
                          <DropdownMenuRadioItem key={option.id} value={option.id}>
                            {option.label}
                          </DropdownMenuRadioItem>
                        ))}
                      </DropdownMenuRadioGroup>
                      <DropdownMenuSeparator />
                      <DropdownMenuLabel className="flex items-center gap-2">
                        <Eye className="size-3.5" />
                        Display properties
                      </DropdownMenuLabel>
                      {LINEAR_DISPLAY_PROPERTIES.map((property) => (
                        <DropdownMenuCheckboxItem
                          key={property.id}
                          checked={effectiveLinearDisplayProperties.has(property.id)}
                          onSelect={(event) => event.preventDefault()}
                          onCheckedChange={() => toggleLinearDisplayProperty(property.id)}
                        >
                          {property.label}
                        </DropdownMenuCheckboxItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <div className="text-[11px] text-muted-foreground">
                    {pagedLinearIssues.length} shown
                  </div>
                </div>
              </div>

              {linearViewMode === 'list' && linearGroupBy === 'none' ? (
                <div
                  className="grid h-8 flex-none items-center gap-3 border-b border-border/50 bg-muted/25 px-3 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground max-lg:!hidden lg:grid-cols-[var(--linear-grid-template)] [&>span]:min-w-0 [&>span]:truncate"
                  style={linearIssueGridStyle}
                >
                  <span>Key</span>
                  <span>Issue</span>
                  {effectiveLinearDisplayProperties.has('labels') ? <span>Labels</span> : null}
                  {effectiveLinearDisplayProperties.has('team') ? <span>Team</span> : null}
                  {effectiveLinearDisplayProperties.has('state') ? <span>Status</span> : null}
                  {effectiveLinearDisplayProperties.has('assignee') ? (
                    <span className="text-center">Assignee</span>
                  ) : null}
                  {effectiveLinearDisplayProperties.has('updated') ? <span>Updated</span> : null}
                  <span />
                </div>
              ) : null}

              <div
                className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek"
                style={{ scrollbarGutter: 'stable' }}
              >
                {activeLinearIssueError ? (
                  <div className="border-b border-border px-4 py-4 text-sm text-destructive">
                    {activeLinearIssueError}
                  </div>
                ) : null}

                {activeLinearIssueLoading && activeLinearIssues.length === 0 ? (
                  <div className="divide-y divide-border/50">
                    {Array.from({ length: 12 }).map((_, i) => (
                      <div key={i} className="px-3 py-3">
                        <div className="h-4 w-4/5 animate-pulse rounded bg-muted/70" />
                        <div className="mt-2 h-3 w-3/5 animate-pulse rounded bg-muted/60" />
                      </div>
                    ))}
                  </div>
                ) : null}

                {!activeLinearIssueLoading &&
                activeLinearIssues.length === 0 &&
                !activeLinearIssueError &&
                activeLinearIssueHasCollectionError ? (
                  <div className="px-4 py-10 text-center">
                    <p className="text-sm font-medium text-foreground">
                      Unable to load Linear issues
                    </p>
                    <p className="mt-2 text-sm text-muted-foreground">
                      Review the workspace error below, then refresh.
                    </p>
                  </div>
                ) : null}

                {!activeLinearIssueLoading &&
                activeLinearIssues.length === 0 &&
                !activeLinearIssueError &&
                !activeLinearIssueHasCollectionError ? (
                  <div className="px-4 py-10 text-center">
                    <p className="text-sm font-medium text-foreground">No Linear issues found</p>
                    <p className="mt-2 text-sm text-muted-foreground">
                      {activeLinearIssueContextLabel
                        ? 'No issues match this Linear context.'
                        : linearSearchInput
                          ? 'Try a different search query.'
                          : 'No assigned issues. Try searching for something.'}
                    </p>
                  </div>
                ) : null}

                {!activeLinearIssueLoading &&
                activeLinearIssues.length > 0 &&
                filteredLinearIssues.length === 0 ? (
                  <div className="px-4 py-10 text-center">
                    <p className="text-sm font-medium text-foreground">
                      No fetched issues match the selected teams
                    </p>
                    <p className="mt-2 text-sm text-muted-foreground">
                      Try selecting more teams or refreshing; team filters apply to the current
                      fetched issue set.
                    </p>
                  </div>
                ) : null}

                {linearViewMode === 'board' ? (
                  <div className="grid min-w-0 gap-3 p-3 md:grid-cols-2 xl:grid-cols-3">
                    {linearBoardSections.map((section) => (
                      <section
                        key={section.key}
                        onDragOver={(event) => handleLinearBoardDragOver(section, event)}
                        onDrop={(event) => void handleLinearBoardDrop(section, event)}
                        className={cn(
                          'min-h-0 rounded-md border border-border/50 bg-muted/20 transition-[border-color,box-shadow]',
                          linearBoardDragOverKey === section.key &&
                            'border-ring/70 ring-1 ring-ring/70'
                        )}
                      >
                        <div className="flex h-9 items-center justify-between border-b border-border/50 px-3">
                          <span className="truncate text-xs font-medium text-foreground">
                            {section.label}
                          </span>
                          <span className="text-[11px] text-muted-foreground">
                            {section.issues.length}
                          </span>
                        </div>
                        <div className="space-y-2 p-2">
                          {section.issues.map((issue) => {
                            const selected = issue.id === selectedLinearIssueId
                            const labels = issue.labels.slice(0, 2)
                            const dragging = linearBoardDraggingIssueId === issue.id
                            const updating = linearBoardUpdatingIssueIds.has(issue.id)
                            const teamLabel =
                              selectedLinearWorkspaceId === 'all' && issue.workspaceName
                                ? `${issue.workspaceName} / ${issue.team.name}`
                                : issue.team.name
                            return (
                              <div
                                key={issue.id}
                                role="button"
                                tabIndex={0}
                                draggable={linearStatusBoardEnabled && !updating}
                                aria-current={selected ? 'true' : undefined}
                                data-current={selected ? 'true' : undefined}
                                aria-disabled={updating ? 'true' : undefined}
                                onDragStart={(event) =>
                                  handleLinearBoardCardDragStart(issue, event)
                                }
                                onDragEnd={() => {
                                  setLinearBoardDraggingIssueId(null)
                                  setLinearBoardDragOverKey(null)
                                }}
                                onClick={() => openLinearDetailPage(issue)}
                                onKeyDown={(e) => {
                                  if (e.target !== e.currentTarget) {
                                    return
                                  }
                                  if (e.key === 'Enter' || e.key === ' ') {
                                    e.preventDefault()
                                    openLinearDetailPage(issue)
                                  }
                                }}
                                className={cn(
                                  'group/row cursor-pointer rounded-md border border-border/50 bg-background px-3 py-2 text-left transition hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                                  linearStatusBoardEnabled &&
                                    !updating &&
                                    'cursor-grab active:cursor-grabbing',
                                  selected && 'bg-accent',
                                  dragging && 'opacity-50',
                                  updating && 'cursor-wait opacity-70'
                                )}
                              >
                                <div className="flex min-w-0 items-start justify-between gap-2">
                                  <div className="min-w-0">
                                    <div className="flex min-w-0 items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
                                      {effectiveLinearDisplayProperties.has('priority') ? (
                                        <LinearPriorityIcon
                                          priority={issue.priority}
                                          className="size-3.5"
                                        />
                                      ) : null}
                                      <span className="truncate">{issue.identifier}</span>
                                    </div>
                                    <h3 className="mt-1 line-clamp-2 text-[13px] font-medium leading-snug text-foreground">
                                      {issue.title}
                                    </h3>
                                  </div>
                                  <div className="flex shrink-0 items-center gap-1 opacity-70 transition-opacity group-hover/row:opacity-100 group-focus-within/row:opacity-100">
                                    <Button
                                      variant="ghost"
                                      size="icon-xs"
                                      data-contextual-tour-target="tasks-start-workspace"
                                      onClick={(event) => {
                                        event.stopPropagation()
                                        handleUseLinearItem(issue)
                                      }}
                                      aria-label={`Start workspace from ${issue.identifier}`}
                                    >
                                      <ArrowRight className="size-3.5" />
                                    </Button>
                                    <Button
                                      variant="ghost"
                                      size="icon-xs"
                                      onClick={(event) => {
                                        event.stopPropagation()
                                        window.api.shell.openUrl(issue.url)
                                      }}
                                      aria-label={`Open ${issue.identifier} in Linear`}
                                    >
                                      <ExternalLink className="size-3.5" />
                                    </Button>
                                  </div>
                                </div>
                                <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                                  {effectiveLinearDisplayProperties.has('state') ? (
                                    <LinearStateCell issue={issue} className="px-1.5 py-0.5" />
                                  ) : null}
                                  {effectiveLinearDisplayProperties.has('assignee') ? (
                                    <span>{issue.assignee?.displayName ?? 'Unassigned'}</span>
                                  ) : null}
                                  {effectiveLinearDisplayProperties.has('team') ? (
                                    <span className="truncate">{teamLabel}</span>
                                  ) : null}
                                  {effectiveLinearDisplayProperties.has('updated') ? (
                                    <span>{formatRelativeTime(issue.updatedAt)}</span>
                                  ) : null}
                                </div>
                                {effectiveLinearDisplayProperties.has('labels') &&
                                issue.labels.length > 0 ? (
                                  <div className="mt-2 flex min-w-0 flex-wrap items-center gap-1">
                                    {labels.map((label) => (
                                      <span
                                        key={label}
                                        className="max-w-[140px] truncate rounded-full border border-border/50 bg-muted/35 px-1.5 py-0.5 text-[10px] text-muted-foreground"
                                      >
                                        {label}
                                      </span>
                                    ))}
                                    {issue.labels.length > labels.length ? (
                                      <span className="text-[10px] text-muted-foreground">
                                        +{issue.labels.length - labels.length}
                                      </span>
                                    ) : null}
                                  </div>
                                ) : null}
                              </div>
                            )
                          })}
                        </div>
                      </section>
                    ))}
                  </div>
                ) : (
                  <div className="divide-y divide-border/50">
                    {linearIssueListRows.map((row) => {
                      if (row.type === 'section') {
                        return (
                          <div
                            key={row.key}
                            className="flex h-9 items-center gap-2 bg-muted/35 px-3"
                          >
                            <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
                            <span className="min-w-0 truncate text-[13px] font-medium text-foreground">
                              {row.label}
                            </span>
                            <span className="shrink-0 text-[11px] text-muted-foreground">
                              {row.count}
                            </span>
                          </div>
                        )
                      }

                      const issue = row.issue
                      const selected = issue.id === selectedLinearIssueId
                      const labels = issue.labels.slice(0, 3)
                      const teamLabel =
                        selectedLinearWorkspaceId === 'all' && issue.workspaceName
                          ? `${issue.workspaceName} / ${issue.team.name}`
                          : issue.team.name
                      return (
                        <div
                          key={issue.id}
                          role="button"
                          tabIndex={0}
                          aria-current={selected ? 'true' : undefined}
                          data-current={selected ? 'true' : undefined}
                          onClick={() => {
                            openLinearDetailPage(issue)
                          }}
                          onKeyDown={(e) => {
                            if (e.target !== e.currentTarget) {
                              return
                            }
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault()
                              openLinearDetailPage(issue)
                            }
                          }}
                          className={cn(
                            'group/row grid min-h-12 cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3 py-2 text-left transition hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring lg:grid-cols-[var(--linear-grid-template)]',
                            selected && 'bg-accent'
                          )}
                          style={linearIssueGridStyle}
                        >
                          <div className="flex min-w-0 items-center gap-2 max-lg:!hidden">
                            <span className="min-w-0 truncate font-mono text-[12px] text-muted-foreground">
                              {issue.identifier}
                            </span>
                          </div>

                          <div className="min-w-0">
                            <div className="flex min-w-0 items-center gap-2">
                              {effectiveLinearDisplayProperties.has('priority') ? (
                                <LinearPriorityIcon priority={issue.priority} />
                              ) : null}
                              <span className="shrink-0 font-mono text-[11px] text-muted-foreground lg:hidden">
                                {issue.identifier}
                              </span>
                              <h3 className="min-w-0 truncate text-[13px] font-medium text-foreground">
                                {issue.title}
                              </h3>
                            </div>
                            <div className="mt-1 flex min-w-0 items-center gap-1.5 lg:!hidden">
                              {effectiveLinearDisplayProperties.has('state') ? (
                                <LinearStateCell issue={issue} className="px-1.5 py-0.5" />
                              ) : null}
                              {effectiveLinearDisplayProperties.has('assignee') ? (
                                <span className="min-w-0 truncate text-[11px] text-muted-foreground">
                                  {issue.assignee?.displayName ?? 'Unassigned'}
                                </span>
                              ) : null}
                              {effectiveLinearDisplayProperties.has('team') ? (
                                <span className="min-w-0 truncate text-[11px] text-muted-foreground">
                                  {teamLabel}
                                </span>
                              ) : null}
                            </div>
                          </div>

                          {effectiveLinearDisplayProperties.has('labels') ? (
                            <div className="flex min-w-0 items-center gap-1 max-lg:!hidden">
                              {labels.map((label) => (
                                <span
                                  key={label}
                                  className="max-w-[150px] truncate rounded-full border border-border/50 bg-muted/35 px-1.5 py-0.5 text-[11px] text-muted-foreground"
                                >
                                  {label}
                                </span>
                              ))}
                              {issue.labels.length > labels.length ? (
                                <span className="text-[11px] text-muted-foreground">
                                  +{issue.labels.length - labels.length}
                                </span>
                              ) : null}
                            </div>
                          ) : null}

                          {effectiveLinearDisplayProperties.has('team') ? (
                            <div className="block min-w-0 text-[12px] text-muted-foreground max-lg:!hidden">
                              <div className="truncate">{teamLabel}</div>
                            </div>
                          ) : null}

                          {effectiveLinearDisplayProperties.has('state') ? (
                            <div className="flex min-w-0 max-lg:!hidden">
                              <LinearStateCell issue={issue} className="max-w-full px-2 py-0.5" />
                            </div>
                          ) : null}

                          {effectiveLinearDisplayProperties.has('assignee') ? (
                            <div className="flex min-w-0 justify-center max-lg:!hidden">
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <div
                                    className="flex size-5 shrink-0 items-center justify-center rounded-full border border-border/50 bg-muted/40 text-[10px] text-muted-foreground"
                                    aria-label={issue.assignee?.displayName ?? 'Unassigned'}
                                  >
                                    {issue.assignee?.avatarUrl ? (
                                      <img
                                        src={issue.assignee.avatarUrl}
                                        alt={issue.assignee.displayName}
                                        className="size-5 rounded-full"
                                      />
                                    ) : (
                                      (issue.assignee?.displayName?.slice(0, 1) ?? '-')
                                    )}
                                  </div>
                                </TooltipTrigger>
                                <TooltipContent side="bottom" sideOffset={6}>
                                  {issue.assignee?.displayName ?? 'Unassigned'}
                                </TooltipContent>
                              </Tooltip>
                            </div>
                          ) : null}

                          {effectiveLinearDisplayProperties.has('updated') ? (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <div className="block min-w-0 truncate text-[12px] text-muted-foreground max-lg:!hidden">
                                  {formatRelativeTime(issue.updatedAt)}
                                </div>
                              </TooltipTrigger>
                              <TooltipContent side="bottom" sideOffset={6}>
                                {new Date(issue.updatedAt).toLocaleString()}
                              </TooltipContent>
                            </Tooltip>
                          ) : null}

                          <div className="flex shrink-0 items-center justify-end gap-1 md:opacity-0 md:transition-opacity md:group-hover/row:opacity-100 md:group-focus-within/row:opacity-100">
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon-xs"
                                  data-contextual-tour-target="tasks-start-workspace"
                                  onClick={(event) => {
                                    event.stopPropagation()
                                    handleUseLinearItem(issue)
                                  }}
                                  aria-label={`Start workspace from ${issue.identifier}`}
                                >
                                  <ArrowRight className="size-3.5" />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent side="bottom" sideOffset={6}>
                                Start
                              </TooltipContent>
                            </Tooltip>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon-xs"
                                  onClick={(event) => {
                                    event.stopPropagation()
                                    window.api.shell.openUrl(issue.url)
                                  }}
                                  aria-label={`Open ${issue.identifier} in Linear`}
                                >
                                  <ExternalLink className="size-3.5" />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent side="bottom" sideOffset={6}>
                                Open in Linear
                              </TooltipContent>
                            </Tooltip>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
              {selectedLinearProject && linearProjectTab === 'issues' ? (
                <>
                  <LinearCollectionNotice
                    errors={linearProjectIssuesResult.errors}
                    hasMore={showLinearEmptyFilteredLoadMore}
                    count={linearProjectIssuesResult.items.length}
                    label="project issues"
                    onLoadMore={handleLinearEmptyFilteredLoadMore}
                    loading={activeLinearIssueLoading}
                    loadMoreLabel="Fetch more"
                  />
                  {showLinearIssuePagination ? (
                    <div className="flex-none border-t border-border/50 bg-muted/50">
                      <PaginationBar
                        currentPage={visibleLinearIssuePage}
                        totalPages={linearIssueTotalPages}
                        loadingTarget={activeLinearIssueLoadingTargetPage}
                        onPageChange={handleLinearIssuePageChange}
                      />
                    </div>
                  ) : null}
                </>
              ) : selectedLinearCustomView?.model === 'issue' ? (
                <>
                  <LinearCollectionNotice
                    errors={linearCustomViewIssuesResult.errors}
                    hasMore={showLinearEmptyFilteredLoadMore}
                    count={linearCustomViewIssuesResult.items.length}
                    label="view issues"
                    onLoadMore={handleLinearEmptyFilteredLoadMore}
                    loading={activeLinearIssueLoading}
                    loadMoreLabel="Fetch more"
                  />
                  {showLinearIssuePagination ? (
                    <div className="flex-none border-t border-border/50 bg-muted/50">
                      <PaginationBar
                        currentPage={visibleLinearIssuePage}
                        totalPages={linearIssueTotalPages}
                        loadingTarget={activeLinearIssueLoadingTargetPage}
                        onPageChange={handleLinearIssuePageChange}
                      />
                    </div>
                  ) : null}
                </>
              ) : (
                <>
                  <LinearCollectionNotice
                    hasMore={showLinearEmptyFilteredLoadMore}
                    count={linearIssues.length}
                    label="issues"
                    onLoadMore={handleLinearEmptyFilteredLoadMore}
                    loading={activeLinearIssueLoading}
                    loadMoreLabel="Fetch more"
                  />
                  {showLinearIssuePagination ? (
                    <div className="flex-none border-t border-border/50 bg-muted/50">
                      <PaginationBar
                        currentPage={visibleLinearIssuePage}
                        totalPages={linearIssueTotalPages}
                        loadingTarget={activeLinearIssueLoadingTargetPage}
                        onPageChange={handleLinearIssuePageChange}
                      />
                    </div>
                  ) : null}
                </>
              )}
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
          className="sm:max-w-2xl"
          onKeyDown={(event) => {
            if (isScreenSubmitShortcut(event)) {
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
                <label className="text-[11px] font-medium text-muted-foreground">Project</label>
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
                        <RepoBadgeLabel name={r.displayName} color={r.badgeColor} />
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
              <GitHubMarkdownComposer
                value={newIssueBody}
                onChange={setNewIssueBody}
                placeholder="What's going on?"
                disabled={newIssueSubmitting}
                minHeightClassName="min-h-40"
                onSubmitShortcut={() => void handleCreateNewIssue()}
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <GitHubIssueLabelSelector
                labels={newIssueRepoLabels.data}
                selectedLabels={newIssueLabels}
                loading={newIssueRepoLabels.loading}
                error={newIssueRepoLabels.error}
                disabled={newIssueSubmitting || !newIssueTargetRepo}
                onChange={setNewIssueLabels}
              />
              <GitHubIssueAssigneeSelector
                assignees={newIssueRepoAssignees.data}
                selectedAssignees={newIssueAssignees}
                loading={newIssueRepoAssignees.loading}
                error={newIssueRepoAssignees.error}
                disabled={newIssueSubmitting || !newIssueTargetRepo}
                onChange={setNewIssueAssignees}
              />
            </div>
            <p className="text-[10px] text-muted-foreground">{submitShortcutLabel} to submit.</p>
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
          showCloseButton={false}
          className="sm:max-w-2xl bg-background border-border shadow-2xl p-0 overflow-hidden flex flex-col gap-0 rounded-xl"
          onKeyDown={(event) => {
            if (isScreenSubmitShortcut(event)) {
              event.preventDefault()
              void handleCreateNewLinearIssue()
            }
          }}
        >
          {/* Header/Team section */}
          <div className="flex items-center justify-between border-b border-border/60 px-5 py-3 bg-muted/10">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                New Issue
              </span>
              <span className="text-muted-foreground/40 text-xs">/</span>
              {availableTeams.length > 1 ? (
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      variant="ghost"
                      size="xs"
                      className="h-7 gap-1 px-2 font-medium text-xs text-foreground hover:bg-muted"
                    >
                      {newLinearIssueTargetTeam?.key ?? 'Select Team'}
                      <ChevronDown className="size-3 text-muted-foreground" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent align="start" className="w-64 p-1">
                    <div className="text-[10px] font-semibold text-muted-foreground px-2 py-1.5 uppercase tracking-wider">
                      Switch Team
                    </div>
                    {availableTeams.map((t) => (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => setNewLinearIssueTeamId(t.id)}
                        className={`w-full flex items-center justify-between text-left px-2 py-1.5 text-xs rounded-sm hover:bg-muted transition-colors ${
                          newLinearIssueTeamId === t.id ? 'bg-muted font-medium' : ''
                        }`}
                      >
                        <span>
                          {t.key} — {t.name}
                        </span>
                        {newLinearIssueTeamId === t.id && <Check className="size-3" />}
                      </button>
                    ))}
                  </PopoverContent>
                </Popover>
              ) : (
                <span className="text-xs font-medium text-foreground">
                  {newLinearIssueTargetTeam?.key ?? ''} — {newLinearIssueTargetTeam?.name ?? ''}
                </span>
              )}
            </div>
            <button
              onClick={() => setNewLinearIssueOpen(false)}
              className="text-muted-foreground hover:text-foreground p-1 rounded-md transition-colors"
              disabled={newLinearIssueSubmitting}
            >
              <X className="size-4" />
            </button>
          </div>

          {/* Form Content */}
          <div className="flex flex-col px-6 py-4 gap-3">
            {/* Title */}
            <input
              autoFocus
              value={newLinearIssueTitle}
              onChange={(e) => setNewLinearIssueTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  void handleCreateNewLinearIssue()
                }
              }}
              placeholder="Issue title"
              disabled={newLinearIssueSubmitting}
              className="text-lg font-semibold bg-transparent border-none outline-none focus:outline-none focus:ring-0 focus-visible:ring-0 p-0 placeholder:text-muted-foreground/40 text-foreground w-full"
            />

            {/* Description */}
            <textarea
              value={newLinearIssueBody}
              onChange={(e) => setNewLinearIssueBody(e.target.value)}
              placeholder="Add description..."
              rows={5}
              disabled={newLinearIssueSubmitting}
              className="w-full min-w-0 text-sm bg-transparent border-none outline-none focus:outline-none focus:ring-0 focus-visible:ring-0 p-0 placeholder:text-muted-foreground/45 text-foreground resize-none max-h-60 overflow-y-auto scrollbar-sleek py-1"
            />

            {/* Attribute Badges Row */}
            <div className="flex flex-wrap items-center gap-2 border-t border-border/40 pt-4 mt-2">
              {/* Status Selector */}
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    disabled={newLinearIssueSubmitting}
                    className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs border border-border/80 bg-muted/15 hover:bg-muted/50 active:bg-muted transition-colors text-foreground/80 cursor-pointer disabled:opacity-50"
                  >
                    {(() => {
                      const selectedState = newLinearStates.data.find(
                        (s) => s.id === newLinearIssueStateId
                      )
                      return (
                        <>
                          <span
                            className="size-2 rounded-full flex-shrink-0"
                            style={{ backgroundColor: selectedState?.color || '#a3a3a3' }}
                          />
                          <span>{selectedState?.name || 'Status'}</span>
                        </>
                      )
                    })()}
                    <ChevronDown className="size-3 text-muted-foreground/70" />
                  </button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-56 p-1">
                  <div className="text-[10px] font-semibold text-muted-foreground px-2 py-1 uppercase tracking-wider">
                    Status
                  </div>
                  {newLinearStates.loading ? (
                    <div className="flex items-center justify-center p-4">
                      <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
                    </div>
                  ) : (
                    <div className="max-h-60 overflow-y-auto scrollbar-sleek">
                      {newLinearStates.data.map((s) => (
                        <button
                          key={s.id}
                          type="button"
                          onClick={() => setNewLinearIssueStateId(s.id)}
                          className={`w-full flex items-center justify-between text-left px-2 py-1.5 text-xs rounded-sm hover:bg-muted transition-colors ${
                            newLinearIssueStateId === s.id
                              ? 'bg-muted font-medium text-foreground'
                              : 'text-foreground/80'
                          }`}
                        >
                          <div className="flex items-center gap-2">
                            <span
                              className="size-2 rounded-full flex-shrink-0"
                              style={{ backgroundColor: s.color || '#a3a3a3' }}
                            />
                            <span>{s.name}</span>
                          </div>
                          {newLinearIssueStateId === s.id && (
                            <Check className="size-3 text-foreground" />
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                </PopoverContent>
              </Popover>

              {/* Assignee Selector */}
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    disabled={newLinearIssueSubmitting}
                    className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs border border-border/80 bg-muted/15 hover:bg-muted/50 active:bg-muted transition-colors text-foreground/80 cursor-pointer disabled:opacity-50"
                  >
                    {(() => {
                      const selectedAssignee = newLinearMembers.data.find(
                        (m) => m.id === newLinearIssueAssigneeId
                      )
                      if (selectedAssignee) {
                        return (
                          <>
                            {selectedAssignee.avatarUrl ? (
                              <img
                                src={selectedAssignee.avatarUrl}
                                alt={selectedAssignee.displayName}
                                className="size-3.5 rounded-full flex-shrink-0"
                              />
                            ) : (
                              <UserRound className="size-3.5 text-muted-foreground/70" />
                            )}
                            <span className="truncate max-w-[100px]">
                              {selectedAssignee.displayName}
                            </span>
                          </>
                        )
                      }
                      return (
                        <>
                          <UserRound className="size-3.5 text-muted-foreground/70" />
                          <span>Assignee</span>
                        </>
                      )
                    })()}
                    <ChevronDown className="size-3 text-muted-foreground/70" />
                  </button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-64 p-1">
                  <div className="text-[10px] font-semibold text-muted-foreground px-2 py-1 uppercase tracking-wider">
                    Assignee
                  </div>
                  {newLinearMembers.loading ? (
                    <div className="flex items-center justify-center p-4">
                      <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
                    </div>
                  ) : (
                    <div className="max-h-60 overflow-y-auto scrollbar-sleek">
                      <button
                        type="button"
                        onClick={() => setNewLinearIssueAssigneeId(null)}
                        className={`w-full flex items-center justify-between text-left px-2 py-1.5 text-xs rounded-sm hover:bg-muted transition-colors ${
                          newLinearIssueAssigneeId === null
                            ? 'bg-muted font-medium text-foreground'
                            : 'text-foreground/80'
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          <UserRound className="size-3.5 text-muted-foreground/50" />
                          <span>Unassigned</span>
                        </div>
                        {newLinearIssueAssigneeId === null && (
                          <Check className="size-3 text-foreground" />
                        )}
                      </button>
                      {newLinearMembers.data.map((m) => (
                        <button
                          key={m.id}
                          type="button"
                          onClick={() => setNewLinearIssueAssigneeId(m.id)}
                          className={`w-full flex items-center justify-between text-left px-2 py-1.5 text-xs rounded-sm hover:bg-muted transition-colors ${
                            newLinearIssueAssigneeId === m.id
                              ? 'bg-muted font-medium text-foreground'
                              : 'text-foreground/80'
                          }`}
                        >
                          <div className="flex items-center gap-2 truncate">
                            {m.avatarUrl ? (
                              <img
                                src={m.avatarUrl}
                                alt={m.displayName}
                                className="size-3.5 rounded-full flex-shrink-0"
                              />
                            ) : (
                              <UserRound className="size-3.5 text-muted-foreground/70" />
                            )}
                            <span className="truncate">{m.displayName}</span>
                          </div>
                          {newLinearIssueAssigneeId === m.id && (
                            <Check className="size-3 text-foreground" />
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                </PopoverContent>
              </Popover>

              {/* Priority Selector */}
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    disabled={newLinearIssueSubmitting}
                    className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs border border-border/80 bg-muted/15 hover:bg-muted/50 active:bg-muted transition-colors text-foreground/80 cursor-pointer disabled:opacity-50"
                  >
                    <LinearPriorityIcon priority={newLinearIssuePriority} className="size-3.5" />
                    <span>
                      {newLinearIssuePriority === 1
                        ? 'Urgent'
                        : newLinearIssuePriority === 2
                          ? 'High'
                          : newLinearIssuePriority === 3
                            ? 'Medium'
                            : newLinearIssuePriority === 4
                              ? 'Low'
                              : 'Priority'}
                    </span>
                    <ChevronDown className="size-3 text-muted-foreground/70" />
                  </button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-48 p-1">
                  <div className="text-[10px] font-semibold text-muted-foreground px-2 py-1 uppercase tracking-wider">
                    Priority
                  </div>
                  {[
                    { val: 0, label: 'No priority' },
                    { val: 1, label: 'Urgent' },
                    { val: 2, label: 'High' },
                    { val: 3, label: 'Medium' },
                    { val: 4, label: 'Low' }
                  ].map((p) => (
                    <button
                      key={p.val}
                      type="button"
                      onClick={() => setNewLinearIssuePriority(p.val)}
                      className={`w-full flex items-center justify-between text-left px-2 py-1.5 text-xs rounded-sm hover:bg-muted transition-colors ${
                        newLinearIssuePriority === p.val
                          ? 'bg-muted font-medium text-foreground'
                          : 'text-foreground/80'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <LinearPriorityIcon priority={p.val} className="size-3.5" />
                        <span>{p.label}</span>
                      </div>
                      {newLinearIssuePriority === p.val && (
                        <Check className="size-3 text-foreground" />
                      )}
                    </button>
                  ))}
                </PopoverContent>
              </Popover>

              {/* Project Selector */}
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    disabled={newLinearIssueSubmitting}
                    className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs border border-border/80 bg-muted/15 hover:bg-muted/50 active:bg-muted transition-colors text-foreground/80 cursor-pointer disabled:opacity-50"
                  >
                    <FolderKanban className="size-3.5 text-muted-foreground/70" />
                    <span className="truncate max-w-[120px]">
                      {(() => {
                        const selectedProj = newLinearIssueProjects.find(
                          (p) => p.id === newLinearIssueProjectId
                        )
                        return selectedProj?.name || 'Project'
                      })()}
                    </span>
                    <ChevronDown className="size-3 text-muted-foreground/70" />
                  </button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-64 p-1">
                  <div className="text-[10px] font-semibold text-muted-foreground px-2 py-1 uppercase tracking-wider">
                    Project
                  </div>
                  {newLinearIssueProjectsLoading ? (
                    <div className="flex items-center justify-center p-4">
                      <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
                    </div>
                  ) : (
                    <div className="max-h-60 overflow-y-auto scrollbar-sleek">
                      <button
                        type="button"
                        onClick={() => setNewLinearIssueProjectId(null)}
                        className={`w-full flex items-center justify-between text-left px-2 py-1.5 text-xs rounded-sm hover:bg-muted transition-colors ${
                          newLinearIssueProjectId === null
                            ? 'bg-muted font-medium text-foreground'
                            : 'text-foreground/80'
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          <FolderKanban className="size-3.5 text-muted-foreground/50" />
                          <span>No Project</span>
                        </div>
                        {newLinearIssueProjectId === null && (
                          <Check className="size-3 text-foreground" />
                        )}
                      </button>
                      {newLinearIssueProjects.map((p) => (
                        <button
                          key={p.id}
                          type="button"
                          onClick={() => setNewLinearIssueProjectId(p.id)}
                          className={`w-full flex items-center justify-between text-left px-2 py-1.5 text-xs rounded-sm hover:bg-muted transition-colors ${
                            newLinearIssueProjectId === p.id
                              ? 'bg-muted font-medium text-foreground'
                              : 'text-foreground/80'
                          }`}
                        >
                          <div className="flex items-center gap-2 truncate">
                            <FolderKanban className="size-3.5 text-muted-foreground/70 flex-shrink-0" />
                            <span className="truncate">{p.name}</span>
                          </div>
                          {newLinearIssueProjectId === p.id && (
                            <Check className="size-3 text-foreground" />
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                </PopoverContent>
              </Popover>

              {/* Labels Selector */}
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    disabled={newLinearIssueSubmitting}
                    className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs border border-border/80 bg-muted/15 hover:bg-muted/50 active:bg-muted transition-colors text-foreground/80 cursor-pointer disabled:opacity-50"
                  >
                    <Tag className="size-3.5 text-muted-foreground/70" />
                    <span>
                      {newLinearIssueLabelIds.length === 0
                        ? 'Labels'
                        : `${newLinearIssueLabelIds.length} label${newLinearIssueLabelIds.length > 1 ? 's' : ''}`}
                    </span>
                    <ChevronDown className="size-3 text-muted-foreground/70" />
                  </button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-64 p-1">
                  <div className="text-[10px] font-semibold text-muted-foreground px-2 py-1 uppercase tracking-wider">
                    Labels
                  </div>
                  {newLinearLabels.loading ? (
                    <div className="flex items-center justify-center p-4">
                      <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
                    </div>
                  ) : (
                    <div className="max-h-60 overflow-y-auto scrollbar-sleek">
                      {newLinearLabels.data.map((l) => {
                        const isSelected = newLinearIssueLabelIds.includes(l.id)
                        return (
                          <button
                            key={l.id}
                            type="button"
                            onClick={() => {
                              if (isSelected) {
                                setNewLinearIssueLabelIds(
                                  newLinearIssueLabelIds.filter((id) => id !== l.id)
                                )
                              } else {
                                setNewLinearIssueLabelIds([...newLinearIssueLabelIds, l.id])
                              }
                            }}
                            className={`w-full flex items-center justify-between text-left px-2 py-1.5 text-xs rounded-sm hover:bg-muted transition-colors ${
                              isSelected
                                ? 'bg-muted font-medium text-foreground'
                                : 'text-foreground/80'
                            }`}
                          >
                            <div className="flex items-center gap-2">
                              <span
                                className="size-2 rounded-full flex-shrink-0"
                                style={{ backgroundColor: l.color || '#a3a3a3' }}
                              />
                              <span>{l.name}</span>
                            </div>
                            {isSelected && <Check className="size-3 text-foreground" />}
                          </button>
                        )
                      })}
                    </div>
                  )}
                </PopoverContent>
              </Popover>
            </div>
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between border-t border-border/60 px-6 py-4 bg-muted/5">
            <span className="text-[10px] text-muted-foreground/60 font-medium">
              {submitShortcutLabel} to submit.
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setNewLinearIssueOpen(false)}
                disabled={newLinearIssueSubmitting}
                className="text-xs h-8 text-muted-foreground hover:text-foreground"
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={() => void handleCreateNewLinearIssue()}
                disabled={
                  !newLinearIssueTargetTeam ||
                  !newLinearIssueTitle.trim() ||
                  newLinearIssueSubmitting
                }
                className="text-xs h-8 bg-foreground text-background hover:bg-foreground/90 disabled:opacity-50"
              >
                {newLinearIssueSubmitting ? (
                  <>
                    <LoaderCircle className="size-3.5 animate-spin mr-1" />
                    Creating…
                  </>
                ) : (
                  'Create issue'
                )}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={newJiraIssueOpen}
        onOpenChange={(open) => {
          if (!newJiraIssueSubmitting) {
            setNewJiraIssueOpen(open)
          }
        }}
      >
        <DialogContent
          className="sm:max-w-lg"
          onKeyDown={(event) => {
            if (isScreenSubmitShortcut(event)) {
              event.preventDefault()
              void handleCreateNewJiraIssue()
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>New Jira issue</DialogTitle>
            <DialogDescription>
              {newJiraIssueTargetProject
                ? `Creates a new issue in ${newJiraIssueTargetProject.key}.`
                : 'Choose a Jira project before creating the issue.'}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1">
                <label className="text-[11px] font-medium text-muted-foreground">Project</label>
                <Popover
                  open={newJiraIssueProjectComboboxOpen}
                  onOpenChange={handleNewJiraIssueProjectComboboxOpenChange}
                >
                  <PopoverTrigger asChild>
                    <Button
                      type="button"
                      variant="outline"
                      role="combobox"
                      aria-expanded={newJiraIssueProjectComboboxOpen}
                      onKeyDown={handleNewJiraIssueProjectTriggerKeyDown}
                      disabled={newJiraIssueSubmitting || sortedAvailableJiraProjects.length === 0}
                      className="h-9 w-full justify-between px-3 text-left text-xs font-normal"
                    >
                      {newJiraIssueTargetProject ? (
                        <span className="min-w-0 truncate">
                          {getJiraProjectDisplayLabel(
                            newJiraIssueTargetProject,
                            includeJiraSiteNameInProjectLabel
                          )}
                        </span>
                      ) : (
                        <span className="min-w-0 truncate text-muted-foreground">Project</span>
                      )}
                      <ChevronDown className="size-3.5 shrink-0 opacity-50" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent
                    align="start"
                    className="w-[var(--radix-popover-trigger-width)] min-w-[18rem] p-0"
                    onOpenAutoFocus={(event) => event.preventDefault()}
                  >
                    <Command
                      shouldFilter={false}
                      value={newJiraIssueProjectCommandValue}
                      onValueChange={setNewJiraIssueProjectCommandValue}
                    >
                      <CommandInput
                        ref={newJiraIssueProjectSearchInputRef}
                        placeholder="Search projects..."
                        value={newJiraIssueProjectQuery}
                        onValueChange={setNewJiraIssueProjectQuery}
                      />
                      <CommandList className="max-h-56">
                        <CommandEmpty>No projects found.</CommandEmpty>
                        {filteredNewJiraIssueProjects.map((project) => {
                          const selectionKey = getJiraProjectSelectionKey(project)
                          const selected = selectionKey === newJiraIssueTargetProjectSelectionKey
                          return (
                            <CommandItem
                              key={selectionKey}
                              value={selectionKey}
                              onSelect={() => handleNewJiraIssueProjectSelect(selectionKey)}
                              className="items-center gap-2 px-3 py-2 text-xs"
                            >
                              <Check
                                className={cn(
                                  'size-3.5 text-foreground',
                                  selected ? 'opacity-100' : 'opacity-0'
                                )}
                              />
                              <span className="min-w-0 flex-1 truncate">
                                {getJiraProjectDisplayLabel(
                                  project,
                                  includeJiraSiteNameInProjectLabel
                                )}
                              </span>
                            </CommandItem>
                          )
                        })}
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-[11px] font-medium text-muted-foreground">Issue type</label>
                <Select
                  value={newJiraIssueTypeId ?? newJiraIssueTargetType?.id ?? undefined}
                  onValueChange={(v) => setNewJiraIssueTypeId(v)}
                  disabled={
                    newJiraIssueSubmitting ||
                    jiraIssueTypesLoading ||
                    availableJiraIssueTypes.length === 0
                  }
                >
                  <SelectTrigger>
                    <SelectValue
                      placeholder={jiraIssueTypesLoading ? 'Loading...' : 'Issue type'}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {availableJiraIssueTypes.map((issueType) => (
                      <SelectItem key={issueType.id} value={issueType.id}>
                        {issueType.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[11px] font-medium text-muted-foreground">Title</label>
              <Input
                autoFocus
                value={newJiraIssueTitle}
                onChange={(e) => setNewJiraIssueTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                    e.preventDefault()
                    void handleCreateNewJiraIssue()
                  }
                }}
                placeholder="Short summary"
                disabled={newJiraIssueSubmitting}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[11px] font-medium text-muted-foreground">
                Description (optional)
              </label>
              <textarea
                value={newJiraIssueBody}
                onChange={(e) => setNewJiraIssueBody(e.target.value)}
                placeholder="What's going on?"
                rows={6}
                disabled={newJiraIssueSubmitting}
                className="w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 resize-none max-h-60 overflow-y-auto scrollbar-sleek"
              />
            </div>
            {jiraCreateFieldsLoading ? (
              <div className="flex items-center gap-2 rounded-md border border-border/50 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                <LoaderCircle className="size-3.5 animate-spin" />
                Loading required Jira fields…
              </div>
            ) : null}
            {jiraCreateFieldsError ? (
              <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {jiraCreateFieldsError}
              </p>
            ) : null}
            {visibleJiraCreateFields.length > 0 ? (
              <div className="grid gap-3 sm:grid-cols-2">
                {visibleJiraCreateFields.map((field) => {
                  const fieldValue = newJiraIssueCustomFieldValues[field.key] ?? ''
                  return (
                    <div key={field.key} className="flex min-w-0 flex-col gap-1">
                      <label className="text-[11px] font-medium text-muted-foreground">
                        {field.name}
                      </label>
                      {field.allowedValues?.length && field.schema?.type !== 'array' ? (
                        <Select
                          value={fieldValue}
                          onValueChange={(value) =>
                            setNewJiraIssueCustomFieldValues((prev) => ({
                              ...prev,
                              [field.key]: value
                            }))
                          }
                          disabled={newJiraIssueSubmitting}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder={`Select ${field.name}`} />
                          </SelectTrigger>
                          <SelectContent>
                            {field.allowedValues.map((value) => {
                              const optionValue = value.id ?? value.value ?? value.name ?? ''
                              return optionValue ? (
                                <SelectItem key={optionValue} value={optionValue}>
                                  {getJiraCreateAllowedValueLabel(value)}
                                </SelectItem>
                              ) : null
                            })}
                          </SelectContent>
                        </Select>
                      ) : (
                        <Input
                          value={fieldValue}
                          onChange={(event) =>
                            setNewJiraIssueCustomFieldValues((prev) => ({
                              ...prev,
                              [field.key]: event.target.value
                            }))
                          }
                          type={field.schema?.type === 'number' ? 'number' : 'text'}
                          placeholder={
                            field.schema?.type === 'array'
                              ? 'Comma-separated values'
                              : `Enter ${field.name}`
                          }
                          disabled={newJiraIssueSubmitting}
                        />
                      )}
                    </div>
                  )
                })}
              </div>
            ) : null}
            <p className="text-[10px] text-muted-foreground">{submitShortcutLabel} to submit.</p>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setNewJiraIssueOpen(false)}
              disabled={newJiraIssueSubmitting}
            >
              Cancel
            </Button>
            <Button
              onClick={() => void handleCreateNewJiraIssue()}
              disabled={
                !newJiraIssueTargetProject ||
                !newJiraIssueTargetType ||
                !newJiraIssueTitle.trim() ||
                hasMissingJiraCreateField ||
                jiraCreateFieldsLoading ||
                newJiraIssueSubmitting
              }
            >
              {newJiraIssueSubmitting ? (
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
        onCreateWorkspace={(item) => {
          setGitlabDialogItem(null)
          handleUseGitLabItem(item)
        }}
        onClose={() => setGitlabDialogItem(null)}
      />

      <LinearApiKeyDialog
        open={linearConnectOpen}
        onOpenChange={setLinearConnectOpen}
        workspace={selectedLinearWorkspace}
        connectLabel={selectedLinearWorkspace ? 'Update access' : 'Add Linear access'}
        onConnected={handleLinearAccessConnected}
      />

      <Dialog
        open={jiraConnectOpen}
        onOpenChange={(open) => {
          if (jiraConnectState !== 'connecting') {
            setJiraConnectOpen(open)
          }
        }}
      >
        <DialogContent
          className="sm:max-w-md"
          onKeyDown={(e) => {
            if (
              e.key === 'Enter' &&
              jiraSiteUrlDraft.trim() &&
              jiraEmailDraft.trim() &&
              jiraApiTokenDraft.trim() &&
              jiraConnectState !== 'connecting'
            ) {
              e.preventDefault()
              void handleJiraConnect()
            }
          }}
        >
          <DialogHeader className="gap-3">
            <DialogTitle className="leading-tight">Connect Jira site</DialogTitle>
            <DialogDescription>
              Use a Jira Cloud site URL, Atlassian email, and API token to browse issues.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <Input
              autoFocus
              placeholder="https://example.atlassian.net"
              value={jiraSiteUrlDraft}
              onChange={(e) => {
                setJiraSiteUrlDraft(e.target.value)
                if (jiraConnectState === 'error') {
                  setJiraConnectState('idle')
                  setJiraConnectError(null)
                }
              }}
              disabled={jiraConnectState === 'connecting'}
            />
            <Input
              type="email"
              placeholder="you@example.com"
              value={jiraEmailDraft}
              onChange={(e) => {
                setJiraEmailDraft(e.target.value)
                if (jiraConnectState === 'error') {
                  setJiraConnectState('idle')
                  setJiraConnectError(null)
                }
              }}
              disabled={jiraConnectState === 'connecting'}
            />
            <Input
              type="password"
              placeholder="Atlassian API token"
              value={jiraApiTokenDraft}
              onChange={(e) => {
                setJiraApiTokenDraft(e.target.value)
                if (jiraConnectState === 'error') {
                  setJiraConnectState('idle')
                  setJiraConnectError(null)
                }
              }}
              disabled={jiraConnectState === 'connecting'}
            />
            {jiraConnectState === 'error' && jiraConnectError && (
              <p className="text-xs text-destructive">{jiraConnectError}</p>
            )}
            <p className="text-xs text-muted-foreground">
              Create a token in{' '}
              <button
                className="text-primary underline-offset-2 hover:underline"
                onClick={() =>
                  window.api.shell.openUrl(
                    'https://id.atlassian.com/manage-profile/security/api-tokens'
                  )
                }
              >
                Atlassian account settings
              </button>
              .
            </p>
            <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground/70">
              <Lock className="size-3 shrink-0" />
              Your token is encrypted via the OS keychain and stored locally.
            </p>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setJiraConnectOpen(false)}
              disabled={jiraConnectState === 'connecting'}
            >
              Cancel
            </Button>
            <Button
              onClick={() => void handleJiraConnect()}
              disabled={
                !jiraSiteUrlDraft.trim() ||
                !jiraEmailDraft.trim() ||
                !jiraApiTokenDraft.trim() ||
                jiraConnectState === 'connecting'
              }
            >
              {jiraConnectState === 'connecting' ? (
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
