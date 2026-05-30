/* eslint-disable max-lines -- Why: duplicated from GitHubItemDialog so the dedicated PR full-page surface can evolve its Primer-styled header without destabilizing the issue dialog; planned to refactor shared parts out later. */
import React, {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { editor as monacoEditor } from 'monaco-editor'
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Braces,
  Check,
  ChevronDown,
  ChevronLeft,
  CircleDashed,
  CircleDot,
  Copy,
  ExternalLink,
  FileText,
  FolderKanban,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  ListChecks,
  LoaderCircle,
  MessageSquare,
  MessageSquarePlus,
  PanelLeftOpen,
  Pencil,
  Plus,
  RefreshCw,
  Send,
  UndoDot,
  Users,
  Wrench,
  X
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { ButtonGroup } from '@/components/ui/button-group'
import { Input } from '@/components/ui/input'
import { useConfirmationDialog } from '@/components/confirmation-dialog'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger
} from '@/components/ui/accordion'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import { detectLanguage } from '@/lib/language-detect'
import { cn } from '@/lib/utils'
import { setWithLRU } from '@/lib/scroll-cache'
import { DiffSectionItem } from '@/components/editor/DiffSectionItem'
import type { DecoratedDiffComment } from '@/components/diff-comments/useDiffCommentDecorator'
import {
  CombinedDiffFileTree,
  createCombinedDiffSectionIndexMap,
  handleCombinedDiffFileTreeNavigation
} from '@/components/editor/CombinedDiffFileTree'
import {
  getDiffSectionEstimatedHeight,
  isIntrinsicHeightImageDiff
} from '@/components/editor/diff-section-layout'
import type { DiffSection } from '@/components/editor/diff-section-types'
import type { CombinedDiffFileTreeEntry } from '@/components/editor/combined-diff-file-tree-model'
import { CHECK_COLOR, CHECK_ICON } from '@/components/right-sidebar/checks-panel-content'
import {
  filterPRCommentsByAudience,
  getPRCommentAudienceCounts,
  getPRCommentAudienceEmptyLabel,
  PR_COMMENT_AUDIENCE_FILTERS,
  type PRCommentAudienceFilter
} from '@/lib/pr-comment-audience'
import {
  getPRCommentGroupCount,
  getPRCommentGroupId,
  getPRCommentGroupRoot,
  groupPRComments,
  isResolvedPRCommentGroup,
  PR_COMMENT_OPEN_AUTHOR_CLASS,
  PR_COMMENT_RESOLVED_AUTHOR_CLASS,
  PR_COMMENT_RESOLVED_CONTAINER_CLASS,
  type PRCommentGroup
} from '@/lib/pr-comment-groups'
import { useAppStore } from '@/store'
import { useAllWorktrees } from '@/store/selectors'
import { callRuntimeRpc, getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import { useRepoLabels, useRepoAssignees, useImmediateMutation } from '@/hooks/useIssueMetadata'
import { useRepoLabelsBySlug, useRepoAssigneesBySlug } from '@/hooks/useGitHubSlugMetadata'
import {
  getGitHubPRReviewerRows,
  normalizeGitHubReviewerLogins
} from '@/components/github-pr-reviewer-display'
import { presentGitHubPRMergeState } from '@/components/github-pr-merge-state'
import { AGENT_CATALOG } from '@/lib/agent-catalog'
import { filterEnabledTuiAgents } from '../../../shared/tui-agent-selection'
import { getConnectionId } from '@/lib/connection-context'
import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import {
  findGithubPrWorkspaceAttachment,
  getGithubPrWorkspaceAttachmentLabel
} from '@/lib/github-pr-workspace-attachment'
import { launchAgentInNewTab } from '@/lib/launch-agent-in-new-tab'
import { launchWorkItemDirect } from '@/lib/launch-work-item-direct'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import type {
  GitHubOwnerRepo,
  GitHubPRFile,
  GitHubPRFileContents,
  GitHubPRFileViewedState,
  GitHubWorkItem,
  GitHubWorkItemDetails,
  GitHubAssignableUser,
  GitHubReaction,
  GitBranchChangeEntry,
  GitDiffResult,
  PRCheckDetail,
  PRCheckRunDetails,
  PRComment,
  TuiAgent
} from '../../../shared/types'

// Why: the GH item dialog can be opened from any work-item list surface and
// doesn't have the full owner/repo context the list's cache entry carries.
// Parsing the canonical `https://github.com/{owner}/{repo}/...` URL is the
// simplest reliable source — the URL is already present on every work item
// and survives the main-process → IPC boundary. Non-GitHub hosts return null,
// which matches the indicator's suppression rule.
function parseOwnerRepoFromItemUrl(url: string): GitHubOwnerRepo | null {
  try {
    const parsed = new URL(url)
    if (parsed.hostname !== 'github.com') {
      return null
    }
    const segments = parsed.pathname.split('/').filter(Boolean)
    if (segments.length < 2) {
      return null
    }
    return { owner: segments[0], repo: segments[1] }
  } catch {
    return null
  }
}

const MonacoCodeExcerpt = lazy(() => import('@/components/editor/MonacoCodeExcerpt'))

export type ItemDialogTab = 'conversation' | 'checks' | 'files'

type MentionOption = {
  login: string
  name?: string | null
  avatarUrl?: string
  source: string
}

type MentionQuery = {
  atIndex: number
  query: string
}

const CODE_CONTEXT_EXPAND_STEP = 5
const CODE_CONTEXT_FALLBACK_LINES = 20
const CODE_CONTEXT_MAX_BLOCK_LINES = CODE_CONTEXT_FALLBACK_LINES * 2 + 1

const REACTION_EMOJI: Record<GitHubReaction['content'], string> = {
  '+1': '👍',
  '-1': '👎',
  laugh: '😄',
  confused: '😕',
  heart: '❤️',
  hooray: '🎉',
  rocket: '🚀',
  eyes: '👀'
}

function normalizeItemDialogTab(
  item: GitHubWorkItem | null,
  tab: ItemDialogTab | undefined
): ItemDialogTab {
  if (item?.type !== 'pr') {
    return 'conversation'
  }
  return tab ?? 'conversation'
}

/** Why: Project-origin rows don't always belong to the active local repo.
 *  When set, GHEditSection routes label/assignee/state mutations through
 *  slug-addressed IPCs against `owner`/`repo` instead of through `repoPath`,
 *  preventing edits from silently landing on the workspace's repo when the
 *  Project view is showing rows from a different repo. See
 *  docs/design/github-project-view-tasks.md §Dialog editing from Project rows.
 */
export type PullRequestPageProjectOrigin = {
  owner: string
  repo: string
  number: number
  type: 'issue' | 'pr'
  projectId: string
  projectItemId: string
  cacheKey: string
}

type PullRequestPageProps = {
  workItem: GitHubWorkItem | null
  repoPath: string | null
  repoId?: string | null
  initialTab?: ItemDialogTab
  backLabel?: string
  /** Called when the user clicks the primary CTA to start work from this item. */
  onUse: (item: GitHubWorkItem) => void
  onReviewRequestsChange?: (
    itemKey: { id: string; repoId: string },
    reviewRequests: GitHubAssignableUser[]
  ) => void
  onClose: () => void
  /** Optional Project-origin context. When set, edits in the dialog are
   *  routed via slug-addressed mutation IPCs against the row's actual repo
   *  instead of the active workspace's `repoPath`. Both can be set
   *  simultaneously (Project mode where the row also lives in the active
   *  workspace) — slug routing wins for writes. */
  projectOrigin?: PullRequestPageProjectOrigin
}

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

function findMentionQuery(value: string, caret: number): MentionQuery | null {
  const beforeCaret = value.slice(0, caret)
  const match = /(^|[\s([{,])@([A-Za-z0-9-]*)$/.exec(beforeCaret)
  if (!match) {
    return null
  }
  const query = match[2] ?? ''
  return {
    atIndex: beforeCaret.length - query.length - 1,
    query
  }
}

function buildMentionOptions({
  item,
  comments,
  participants,
  assignableUsers
}: {
  item: GitHubWorkItem
  comments: PRComment[]
  participants: GitHubAssignableUser[]
  assignableUsers: GitHubAssignableUser[]
}): MentionOption[] {
  const byLogin = new Map<string, MentionOption>()
  const add = (
    login: string | null | undefined,
    source: string,
    avatarUrl?: string,
    name?: string | null
  ): void => {
    if (!login || login === 'ghost') {
      return
    }
    const key = login.toLowerCase()
    const existing = byLogin.get(key)
    if (existing) {
      if (!existing.avatarUrl && avatarUrl) {
        existing.avatarUrl = avatarUrl
      }
      if (!existing.name && name) {
        existing.name = name
      }
      return
    }
    byLogin.set(key, { login, source, avatarUrl, name })
  }

  add(item.author, item.type === 'pr' ? 'PR author' : 'Issue author')
  for (const comment of comments) {
    add(comment.author, 'Commenter', comment.authorAvatarUrl)
  }
  for (const user of participants) {
    add(user.login, 'Participant', user.avatarUrl, user.name)
  }
  for (const user of assignableUsers) {
    add(user.login, 'Team member', user.avatarUrl, user.name)
  }

  return Array.from(byLogin.values())
}

function filterMentionOptions(options: MentionOption[], query: string): MentionOption[] {
  const normalizedQuery = query.toLowerCase()
  const filtered = normalizedQuery
    ? options.filter(
        (option) =>
          option.login.toLowerCase().includes(normalizedQuery) ||
          (option.name ?? '').toLowerCase().includes(normalizedQuery)
      )
    : options
  return filtered.slice(0, 8)
}

function getStateLabel(item: GitHubWorkItem): string {
  if (item.type === 'pr') {
    if (item.state === 'merged') {
      return 'Merged'
    }
    if (item.state === 'draft') {
      return 'Draft'
    }
    if (item.state === 'closed') {
      return 'Closed'
    }
    return 'Open'
  }
  return item.state === 'closed' ? 'Closed' : 'Open'
}

function getStateTone(item: GitHubWorkItem): string {
  if (item.type === 'pr') {
    if (item.state === 'merged') {
      return 'border-purple-500/30 bg-purple-500/10 text-purple-600 dark:text-purple-300'
    }
    if (item.state === 'draft') {
      return 'border-slate-500/30 bg-slate-500/10 text-slate-600 dark:text-slate-300'
    }
    if (item.state === 'closed') {
      return 'border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-300'
    }
    return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300'
  }
  if (item.state === 'closed') {
    return 'border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-300'
  }
  return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300'
}

function WorkItemStateBadge({
  item,
  className
}: {
  item: GitHubWorkItem
  className?: string
}): React.JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex h-5 items-center rounded-full border px-2 text-[11px] font-medium',
        getStateTone(item),
        className
      )}
    >
      {getStateLabel(item)}
    </span>
  )
}

function ReviewerAvatar({
  login,
  avatarUrl
}: {
  login: string
  avatarUrl: string
}): React.JSX.Element {
  if (avatarUrl) {
    return (
      <img
        src={avatarUrl}
        alt=""
        loading="lazy"
        decoding="async"
        title={login}
        className="size-6 shrink-0 rounded-full border border-border/50 bg-muted object-cover"
      />
    )
  }
  return (
    <span
      title={login}
      className="inline-flex size-6 shrink-0 items-center justify-center rounded-full border border-border/50 bg-muted text-[10px] font-medium text-muted-foreground"
    >
      {login.slice(0, 1).toUpperCase()}
    </span>
  )
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

function PRReviewersPanel({
  item,
  loading,
  repoPath,
  onReviewersRequested
}: {
  item: GitHubWorkItem
  loading: boolean
  repoPath: string | null
  onReviewersRequested: (reviewRequests: GitHubAssignableUser[]) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [reviewerInput, setReviewerInput] = useState('')
  const [reviewerPickerSide, setReviewerPickerSide] = useState<'top' | 'bottom'>('bottom')
  const [reviewerPickerMaxHeight, setReviewerPickerMaxHeight] = useState<number | null>(null)
  const [activeReviewerIndex, setActiveReviewerIndex] = useState(0)
  const [submitting, setSubmitting] = useState(false)
  const [localReviewRequests, setLocalReviewRequests] = useState<GitHubAssignableUser[]>(
    () => item.reviewRequests ?? []
  )
  const patchWorkItem = useAppStore((s) => s.patchWorkItem)
  const settings = useAppStore((s) => s.settings)
  const reviewerInputRef = useRef<HTMLInputElement | null>(null)
  const reviewerInputFocusFrameRef = useRef<number | null>(null)
  const reviewerPanelMountedRef = useRef(true)

  const cancelReviewerInputFocusFrame = useCallback((): void => {
    if (reviewerInputFocusFrameRef.current !== null) {
      cancelAnimationFrame(reviewerInputFocusFrameRef.current)
      reviewerInputFocusFrameRef.current = null
    }
  }, [])

  const scheduleReviewerInputFocus = useCallback((): void => {
    if (!reviewerPanelMountedRef.current) {
      return
    }
    cancelReviewerInputFocusFrame()
    reviewerInputFocusFrameRef.current = requestAnimationFrame(() => {
      reviewerInputFocusFrameRef.current = null
      reviewerInputRef.current?.focus()
    })
  }, [cancelReviewerInputFocusFrame])

  useEffect(() => {
    reviewerPanelMountedRef.current = true
    return () => {
      reviewerPanelMountedRef.current = false
      cancelReviewerInputFocusFrame()
    }
  }, [cancelReviewerInputFocusFrame])

  useEffect(() => {
    setLocalReviewRequests(item.reviewRequests ?? [])
  }, [item.id, item.reviewRequests])

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

  const reviewSlug = useMemo(() => parseOwnerRepoFromItemUrl(item.url), [item.url])
  const reviewerMetadataBySlug = useRepoAssigneesBySlug(
    open && reviewSlug ? reviewSlug.owner : null,
    open && reviewSlug ? reviewSlug.repo : null,
    reviewerSeedUsers.map((user) => user.login),
    settings
  )
  const reviewerMetadataByPath = useRepoAssignees(
    open && !reviewSlug ? repoPath : null,
    open && !reviewSlug ? item.repoId : null
  )
  const reviewerMetadata = reviewSlug ? reviewerMetadataBySlug : reviewerMetadataByPath
  const displayItem = { ...item, reviewRequests: localReviewRequests }
  const reviewers = getGitHubPRReviewerRows(displayItem)
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

  useEffect(() => {
    setActiveReviewerIndex(0)
  }, [reviewerQuery, actionableReviewerRows.length])

  const hasReviewerMetadata =
    item.reviewDecision !== undefined ||
    localReviewRequests.length > 0 ||
    item.reviewRequests !== undefined ||
    item.latestReviews !== undefined
  const canRequestReview = !!repoPath || getActiveRuntimeTarget(settings).kind === 'environment'

  const measureReviewerPickerPlacement = useCallback(() => {
    const rect = reviewerInputRef.current?.getBoundingClientRect()
    if (!rect) {
      setReviewerPickerSide('bottom')
      setReviewerPickerMaxHeight(null)
      return
    }

    const gap = 8
    const minUsefulHeight = 180
    const availableBelow = window.innerHeight - rect.bottom - gap
    const availableAbove = rect.top - gap
    const nextSide =
      availableBelow < minUsefulHeight && availableAbove > availableBelow ? 'top' : 'bottom'
    const available = nextSide === 'top' ? availableAbove : availableBelow

    setReviewerPickerSide(nextSide)
    setReviewerPickerMaxHeight(Math.max(120, Math.min(330, available)))
  }, [])

  const handleRequestReview = async (requestedLogins?: string[]): Promise<void> => {
    if (submitting) {
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
    const target = getActiveRuntimeTarget(settings)
    if (target.kind !== 'environment' && !repoPath) {
      toast.error('No repo context available for this pull request.')
      return
    }
    setSubmitting(true)
    try {
      const result =
        target.kind === 'environment'
          ? await callRuntimeRpc<{ ok: boolean; error?: string }>(
              target,
              'github.requestPRReviewers',
              { repo: item.repoId, prNumber: item.number, reviewers: logins },
              { timeoutMs: 30_000 }
            )
          : await window.api.gh.requestPRReviewers({
              repoPath: repoPath ?? '',
              repoId: item.repoId,
              prNumber: item.number,
              reviewers: logins
            })
      if (!result.ok) {
        toast.error(result.error ?? 'Failed to request reviewer')
        return
      }
      const nextReviewRequests = buildRequestedReviewUsers(
        logins,
        reviewerCandidates,
        localReviewRequests
      )
      setLocalReviewRequests(nextReviewRequests)
      patchWorkItem(item.id, { reviewRequests: nextReviewRequests }, item.repoId)
      onReviewersRequested(nextReviewRequests)
      setReviewerInput('')
      toast.success(logins.length === 1 ? 'Reviewer requested' : 'Reviewers requested')
    } catch {
      toast.error('Failed to request reviewer')
    } finally {
      setSubmitting(false)
    }
  }

  const handleRemoveReviewers = async (reviewersToRemove: string[]): Promise<void> => {
    if (submitting) {
      return
    }
    const selected = new Set(localReviewRequests.map((reviewer) => reviewer.login.toLowerCase()))
    const logins = reviewersToRemove
      .map((reviewer) => reviewer.trim().replace(/^@/, ''))
      .filter((reviewer) => reviewer.length > 0 && selected.has(reviewer.toLowerCase()))
    if (logins.length === 0) {
      return
    }
    const target = getActiveRuntimeTarget(settings)
    if (target.kind !== 'environment' && !repoPath) {
      toast.error('No repo context available for this pull request.')
      return
    }
    setSubmitting(true)
    try {
      const result =
        target.kind === 'environment'
          ? await callRuntimeRpc<{ ok: boolean; error?: string }>(
              target,
              'github.removePRReviewers',
              { repo: item.repoId, prNumber: item.number, reviewers: logins },
              { timeoutMs: 30_000 }
            )
          : await window.api.gh.removePRReviewers({
              repoPath: repoPath ?? '',
              repoId: item.repoId,
              prNumber: item.number,
              reviewers: logins
            })
      if (!result.ok) {
        toast.error(result.error ?? 'Failed to remove reviewer')
        return
      }
      const removed = new Set(logins.map((login) => login.toLowerCase()))
      const nextReviewRequests = localReviewRequests.filter(
        (reviewer) => !removed.has(reviewer.login.toLowerCase())
      )
      setLocalReviewRequests(nextReviewRequests)
      patchWorkItem(item.id, { reviewRequests: nextReviewRequests }, item.repoId)
      onReviewersRequested(nextReviewRequests)
      setReviewerInput('')
      toast.success(logins.length === 1 ? 'Reviewer removed' : 'Reviewers removed')
    } catch {
      toast.error('Failed to remove reviewer')
    } finally {
      setSubmitting(false)
    }
  }

  const requestReviewer = async (reviewer: GitHubAssignableUser): Promise<void> => {
    await (selectedReviewerLogins.has(reviewer.login.toLowerCase())
      ? handleRemoveReviewers([reviewer.login])
      : handleRequestReview([reviewer.login]))
    scheduleReviewerInputFocus()
  }

  const handleReviewerPickerOpenChange = (nextOpen: boolean): void => {
    if (nextOpen) {
      measureReviewerPickerPlacement()
    }
    setOpen(nextOpen)
    if (nextOpen) {
      scheduleReviewerInputFocus()
      return
    }
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
        aria-label={
          selected ? `Unrequest reviewer ${reviewer.login}` : `Request reviewer ${reviewer.login}`
        }
        aria-pressed={selected}
        className={cn(
          'flex min-h-10 w-full items-center gap-2 border-b border-border/70 px-3 py-2 text-left text-[13px] outline-none last:border-b-0 hover:bg-accent/70 focus-visible:bg-accent focus-visible:text-accent-foreground',
          active && 'bg-accent text-accent-foreground',
          selected && 'font-medium'
        )}
        onMouseEnter={() => setActiveReviewerIndex(options.activeIndex)}
        onMouseDown={(event) => {
          event.preventDefault()
        }}
        onFocus={() => setActiveReviewerIndex(options.activeIndex)}
        onClick={() => {
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
              Recently edited these files
            </span>
          ) : null}
        </span>
      </button>
    )
  }

  return (
    <aside className="rounded-lg border border-border/50 bg-card shadow-xs">
      <div className="flex h-10 items-center gap-2 border-b border-border/50 px-3">
        <Users className="size-3.5 text-muted-foreground" />
        <span className="text-[13px] font-medium text-foreground">Reviewers</span>
        {reviewers.length > 0 ? (
          <span className="ml-auto rounded-full border border-border/50 bg-muted/30 px-1.5 py-0.5 text-[11px] tabular-nums text-muted-foreground">
            {reviewers.length}
          </span>
        ) : null}
      </div>
      <div className="px-3 py-2.5">
        {loading && !hasReviewerMetadata ? (
          <div className="flex items-center gap-2 py-1 text-[12px] text-muted-foreground">
            <LoaderCircle className="size-3.5 animate-spin" />
            Loading reviewers
          </div>
        ) : reviewers.length > 0 ? (
          <div className="flex flex-col gap-2">
            {reviewers.map((reviewer) => {
              const canRemoveReviewer = selectedReviewerLogins.has(reviewer.login.toLowerCase())
              return (
                <div key={reviewer.login} className="flex min-w-0 items-center gap-2">
                  <ReviewerAvatar login={reviewer.login} avatarUrl={reviewer.avatarUrl} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium text-foreground">
                      {reviewer.login}
                    </div>
                    {reviewer.name ? (
                      <div className="truncate text-[11px] text-muted-foreground">
                        {reviewer.name}
                      </div>
                    ) : null}
                  </div>
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    {reviewer.stateLabel}
                  </span>
                  {canRemoveReviewer ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          className="size-6 shrink-0 text-muted-foreground hover:text-foreground"
                          disabled={submitting || !canRequestReview}
                          aria-label={`Remove reviewer ${reviewer.login}`}
                          onClick={() => {
                            void handleRemoveReviewers([reviewer.login])
                          }}
                        >
                          <X className="size-3.5" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Remove reviewer</TooltipContent>
                    </Tooltip>
                  ) : null}
                </div>
              )
            })}
          </div>
        ) : (
          <div className="py-1 text-[12px] text-muted-foreground">No reviewers requested.</div>
        )}
        <Popover open={open} onOpenChange={handleReviewerPickerOpenChange}>
          <PopoverAnchor asChild>
            <Input
              ref={reviewerInputRef}
              value={reviewerInput}
              onChange={(event) => {
                setReviewerInput(event.target.value)
                if (!open) {
                  handleReviewerPickerOpenChange(true)
                }
              }}
              disabled={submitting || !canRequestReview}
              placeholder="Type or choose a user"
              aria-label="Reviewer"
              aria-expanded={open}
              aria-haspopup="listbox"
              className="mt-3 h-8 min-w-0 cursor-text rounded-md border-border/50 bg-background text-xs"
              onFocus={() => {
                if (canRequestReview) {
                  handleReviewerPickerOpenChange(true)
                }
              }}
              onClick={() => {
                if (canRequestReview) {
                  handleReviewerPickerOpenChange(true)
                }
              }}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown' && actionableReviewerRows.length > 0) {
                  event.preventDefault()
                  setOpen(true)
                  setActiveReviewerIndex((current) => (current + 1) % actionableReviewerRows.length)
                  return
                }
                if (event.key === 'ArrowUp' && actionableReviewerRows.length > 0) {
                  event.preventDefault()
                  setOpen(true)
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
          </PopoverAnchor>
          <PopoverContent
            className="flex w-[330px] flex-col overflow-hidden rounded-md border-border/70 p-0"
            align="start"
            side={reviewerPickerSide}
            sideOffset={6}
            avoidCollisions={false}
            style={{
              maxHeight: reviewerPickerMaxHeight ? `${reviewerPickerMaxHeight}px` : undefined
            }}
            onOpenAutoFocus={(event) => {
              event.preventDefault()
            }}
          >
            <div className="border-b border-border/70 px-3 py-2">
              <div className="text-[13px] font-semibold text-foreground">
                Request up to 15 reviewers
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek">
              {reviewerMetadata.loading ? (
                <div className="px-3 py-2 text-[13px] text-muted-foreground">Loading...</div>
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
      </div>
    </aside>
  )
}

function isPRFileViewed(file: GitHubPRFile): boolean {
  return file.viewerViewedState === 'VIEWED'
}

function findNearestBraceBlock(
  lines: string[],
  targetLine: number
): { startLine: number; endLine: number } | null {
  const stack: number[] = []
  const ranges: { startLine: number; endLine: number }[] = []
  const targetIndex = targetLine - 1

  lines.forEach((line, lineIndex) => {
    for (const character of line) {
      if (character === '{') {
        stack.push(lineIndex)
      } else if (character === '}') {
        const startLine = stack.pop()
        if (startLine !== undefined && startLine <= lineIndex) {
          ranges.push({ startLine: startLine + 1, endLine: lineIndex + 1 })
        }
      }
    }
  })

  const containingRange = ranges
    .filter((range) => range.startLine - 1 <= targetIndex && targetIndex <= range.endLine - 1)
    .sort((a, b) => a.endLine - a.startLine - (b.endLine - b.startLine))[0]

  if (containingRange) {
    return containingRange
  }

  return (
    ranges
      .filter(
        (range) => range.startLine - 1 >= targetIndex && range.startLine - 1 - targetIndex <= 8
      )
      .sort((a, b) => a.startLine - b.startLine)[0] ?? null
  )
}

// Why: SWR cache for the work-item details fetch. Reopening the same drawer
// pays full IPC + `gh` process startup latency without this; with it, cached
// data paints immediately while a background refetch keeps the view honest.
// Cache is keyed by repoPath + issueSourcePreference + type + number so
// upstream/origin source toggles and issue#N vs pr#N never collide. Bounded
// to ~50 entries to cap memory; entries older than FRESH_MS trigger a
// background refetch on open. See docs/gh-work-item-drawer-cache.md.
const WORK_ITEM_DETAILS_CACHE_MAX = 50
const WORK_ITEM_DETAILS_FRESH_MS = 30_000
type WorkItemDetailsCacheEntry = {
  details: GitHubWorkItemDetails | null
  fetchedAt: number
  pending?: Promise<GitHubWorkItemDetails | null>
  error?: string
}
const workItemDetailsCache = new Map<string, WorkItemDetailsCacheEntry>()

// Why: drawers subscribe via useSyncExternalStore so reopening a cached item
// paints synchronously on first render. Stability of the snapshot relies on
// every cache write replacing the entry object identity (delete+set), which
// touchWorkItemDetailsCache already does.
const workItemDetailsCacheListeners = new Set<() => void>()
function subscribeWorkItemDetailsCache(listener: () => void): () => void {
  workItemDetailsCacheListeners.add(listener)
  return () => {
    workItemDetailsCacheListeners.delete(listener)
  }
}
function notifyWorkItemDetailsCache(): void {
  for (const listener of workItemDetailsCacheListeners) {
    listener()
  }
}

function getWorkItemDetailsCacheKey(args: {
  repoPath: string
  repoId: string
  issueSourcePreference: string | undefined
  type: 'issue' | 'pr'
  number: number
}): string {
  // Why: include all axes that change which (repo, item) the IPC resolves to.
  // `\0` separator avoids ambiguity between fields that may contain `:` or `/`.
  return [args.repoId, args.issueSourcePreference ?? 'auto', args.type, args.number].join('\0')
}

function touchWorkItemDetailsCache(key: string, entry: WorkItemDetailsCacheEntry): void {
  // Why: re-insert to move to MRU position; Map preserves insertion order so
  // the oldest key is always first when evicting.
  workItemDetailsCache.delete(key)
  workItemDetailsCache.set(key, entry)
  while (workItemDetailsCache.size > WORK_ITEM_DETAILS_CACHE_MAX) {
    const oldest = workItemDetailsCache.keys().next().value
    if (oldest === undefined) {
      break
    }
    workItemDetailsCache.delete(oldest)
  }
  notifyWorkItemDetailsCache()
}

// Why: exposed so mutation handlers (in this file and elsewhere) can drop a
// stale entry after a successful local mutation. Cross-window invalidation
// arrives via the `gh:workItemMutated` event listener installed below.
export function invalidateWorkItemDetailsCacheForKey(key: string): void {
  // Why: bump generation so an in-flight fetch launched before this exact-key
  // invalidation will not write its stale result back into the cache.
  workItemDetailsCacheGeneration += 1
  const existed = workItemDetailsCache.delete(key)
  if (existed) {
    notifyWorkItemDetailsCache()
  }
}

// Why: monotonically increases on every invalidation so an in-flight refetch
// that started before a mutation can detect that its result is stale and
// must not be written back. Without this, a mutation that lands while a
// refetch is in flight would have its invalidation silently undone when the
// stale promise resolves and re-populates the entry.
let workItemDetailsCacheGeneration = 0

// Why: when we don't have the exact cache key (e.g. an event from another
// window only carries repoPath + number + type), drop every entry that
// matches the (repoPath, type, number) tuple regardless of source preference.
function invalidateWorkItemDetailsCacheByMatch(args: {
  repoPath: string
  repoId?: string
  type: 'issue' | 'pr'
  number: number
}): void {
  workItemDetailsCacheGeneration += 1
  const suffix = `\0${args.type}\0${args.number}`
  const prefix = `${args.repoId ?? args.repoPath}\0`
  let removed = false
  for (const key of Array.from(workItemDetailsCache.keys())) {
    if (key.startsWith(prefix) && key.endsWith(suffix)) {
      workItemDetailsCache.delete(key)
      removed = true
    }
  }
  if (removed) {
    notifyWorkItemDetailsCache()
  }
}

function patchCachedPRFileViewedState(
  cacheKey: string,
  path: string,
  viewerViewedState: GitHubPRFileViewedState
): GitHubPRFileViewedState | undefined {
  const prev = workItemDetailsCache.get(cacheKey)
  const files = prev?.details?.files
  if (!prev?.details || !files) {
    return undefined
  }
  let previousState: GitHubPRFileViewedState | undefined
  const nextFiles = files.map((file) => {
    if (file.path !== path) {
      return file
    }
    previousState = file.viewerViewedState ?? 'UNVIEWED'
    return { ...file, viewerViewedState }
  })
  if (previousState === undefined || previousState === viewerViewedState) {
    return previousState
  }
  touchWorkItemDetailsCache(cacheKey, {
    ...prev,
    details: { ...prev.details, files: nextFiles },
    error: undefined
  })
  return previousState
}

function patchCachedPRChecks(cacheKey: string, checks: PRCheckDetail[]): void {
  const prev = workItemDetailsCache.get(cacheKey)
  if (!prev?.details) {
    return
  }
  touchWorkItemDetailsCache(cacheKey, {
    ...prev,
    details: { ...prev.details, checks },
    fetchedAt: Date.now(),
    error: undefined
  })
}

function patchCachedPRReviewRequests(
  cacheKey: string,
  reviewRequests: GitHubAssignableUser[]
): void {
  const prev = workItemDetailsCache.get(cacheKey)
  if (!prev?.details) {
    return
  }
  touchWorkItemDetailsCache(cacheKey, {
    ...prev,
    details: {
      ...prev.details,
      item: { ...prev.details.item, reviewRequests }
    },
    fetchedAt: Date.now(),
    error: undefined
  })
}

function patchCachedWorkItemBody(cacheKey: string, body: string): void {
  const prev = workItemDetailsCache.get(cacheKey)
  if (!prev?.details) {
    return
  }
  touchWorkItemDetailsCache(cacheKey, {
    ...prev,
    details: { ...prev.details, body },
    fetchedAt: Date.now(),
    error: undefined
  })
}

// Why: install once at module load — every dialog instance shares the cache,
// so a single subscription is enough. The preload bridge re-emits the
// main-process broadcast for every window, so each renderer invalidates its
// own cache when any window's mutation lands. We track the unsubscribe so
// Vite HMR doesn't accumulate listeners across module reloads in dev.
let workItemMutatedUnsub: (() => void) | undefined
if (typeof window !== 'undefined' && window.api?.gh?.onWorkItemMutated) {
  workItemMutatedUnsub = window.api.gh.onWorkItemMutated((payload) => {
    invalidateWorkItemDetailsCacheByMatch({
      repoPath: payload.repoPath,
      repoId: payload.repoId,
      type: payload.type,
      number: payload.number
    })
  })
}
if (typeof import.meta !== 'undefined' && import.meta.hot) {
  import.meta.hot.dispose(() => {
    workItemMutatedUnsub?.()
  })
}

// Why: bounded LRU — opening many PRs with many files during a session
// would otherwise grow this module-level map without bound until reload.
const PR_FILE_CONTENT_CACHE_MAX = 64
const prFileContentCache = new Map<string, Promise<GitHubPRFileContents> | GitHubPRFileContents>()

function touchPRFileContentCache(
  key: string,
  value: Promise<GitHubPRFileContents> | GitHubPRFileContents
): void {
  // Why: re-insert to move to the most-recently-used position; Map preserves
  // insertion order so the oldest key is always first when evicting.
  prFileContentCache.delete(key)
  prFileContentCache.set(key, value)
  while (prFileContentCache.size > PR_FILE_CONTENT_CACHE_MAX) {
    const oldest = prFileContentCache.keys().next().value
    if (oldest === undefined) {
      break
    }
    prFileContentCache.delete(oldest)
  }
}

function getPRFileContentCacheKey(args: {
  repoPath: string
  repoId: string
  prNumber: number
  file: GitHubPRFile
  headSha: string
  baseSha: string
}): string {
  return [
    args.repoId,
    args.prNumber,
    args.file.path,
    args.file.oldPath ?? '',
    args.file.status,
    args.headSha,
    args.baseSha
  ].join('\0')
}

function loadPRFileContents(args: {
  repoPath: string
  repoId: string
  prNumber: number
  file: GitHubPRFile
  headSha: string
  baseSha: string
}): Promise<GitHubPRFileContents> {
  const cacheKey = getPRFileContentCacheKey(args)
  const cached = prFileContentCache.get(cacheKey)
  if (cached) {
    touchPRFileContentCache(cacheKey, cached)
    return Promise.resolve(cached)
  }
  const request = window.api.gh
    .prFileContents({
      repoPath: args.repoPath,
      repoId: args.repoId,
      prNumber: args.prNumber,
      path: args.file.path,
      oldPath: args.file.oldPath,
      status: args.file.status,
      headSha: args.headSha,
      baseSha: args.baseSha
    })
    .then((contents) => {
      touchPRFileContentCache(cacheKey, contents)
      return contents
    })
    .catch((err) => {
      prFileContentCache.delete(cacheKey)
      throw err
    })
  touchPRFileContentCache(cacheKey, request)
  return request
}

function addIssueCommentForRepo(args: {
  repoId?: string
  repoPath: string
  number: number
  body: string
  type?: 'issue' | 'pr'
}): Promise<Awaited<ReturnType<typeof window.api.gh.addIssueComment>>> {
  return window.api.gh.addIssueComment({
    repoPath: args.repoPath,
    repoId: args.repoId,
    number: args.number,
    body: args.body,
    type: args.type
  })
}

function addPRReviewCommentForRepo(args: {
  repoId?: string
  repoPath: string
  prNumber: number
  commitId: string
  path: string
  line: number
  startLine?: number
  body: string
}): Promise<Awaited<ReturnType<typeof window.api.gh.addPRReviewComment>>> {
  return window.api.gh.addPRReviewComment({
    repoPath: args.repoPath,
    repoId: args.repoId,
    prNumber: args.prNumber,
    commitId: args.commitId,
    path: args.path,
    line: args.line,
    startLine: args.startLine,
    body: args.body
  })
}

function addPRReviewCommentReplyForRepo(args: {
  repoId?: string
  repoPath: string
  prNumber: number
  commentId: number
  body: string
  threadId?: string
  path?: string
  line?: number
}): Promise<Awaited<ReturnType<typeof window.api.gh.addPRReviewCommentReply>>> {
  return window.api.gh.addPRReviewCommentReply({
    repoPath: args.repoPath,
    repoId: args.repoId,
    prNumber: args.prNumber,
    commentId: args.commentId,
    body: args.body,
    threadId: args.threadId,
    path: args.path,
    line: args.line
  })
}

function setPRFileViewedForRepo(args: {
  repoId?: string
  repoPath: string
  prNumber: number
  pullRequestId: string
  path: string
  viewed: boolean
}): Promise<boolean> {
  return window.api.gh.setPRFileViewed({
    repoPath: args.repoPath,
    repoId: args.repoId,
    prNumber: args.prNumber,
    pullRequestId: args.pullRequestId,
    path: args.path,
    viewed: args.viewed
  })
}

function getWorkItemDetailsForRepo(args: {
  repoId?: string
  repoPath: string
  number: number
  type: 'issue' | 'pr'
}): Promise<GitHubWorkItemDetails | null> {
  return window.api.gh.workItemDetails({
    repoPath: args.repoPath,
    repoId: args.repoId,
    number: args.number,
    type: args.type
  })
}

function PRViewedCheckbox({
  checked,
  pending,
  filePath,
  onToggle
}: {
  checked: boolean
  pending: boolean
  filePath: string
  onToggle: () => void
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          role="checkbox"
          aria-checked={checked}
          aria-label={`${checked ? 'Unmark' : 'Mark'} ${filePath} as viewed`}
          disabled={pending}
          onClick={(event) => {
            event.stopPropagation()
            onToggle()
          }}
          className={cn(
            'flex h-6 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-[11px] text-muted-foreground transition hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            checked && 'text-foreground',
            pending && 'cursor-default opacity-60'
          )}
        >
          <span
            className={cn(
              'flex size-4 items-center justify-center rounded-sm border transition-colors',
              checked
                ? 'border-foreground bg-foreground text-background'
                : 'border-muted-foreground/50 bg-background text-transparent'
            )}
          >
            {pending ? (
              <LoaderCircle className="size-3 animate-spin text-muted-foreground" />
            ) : checked ? (
              <Check className="size-3" strokeWidth={3} />
            ) : null}
          </span>
          <span>Viewed</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={4}>
        {checked ? 'Unmark viewed' : 'Mark viewed'}
      </TooltipContent>
    </Tooltip>
  )
}

const PR_DIFF_OVERSCAN = 5

type CachedPRFilesDiffViewState = {
  entrySignature: string
  sections: DiffSection[]
  sectionHeights: Record<number, number>
  loadedIndices: number[]
  scrollTop: number
  sideBySide: boolean
  fileTreeCollapsed: boolean
  activeTreeSectionKey: string | null
}

const prFilesDiffViewStateCache = new Map<string, CachedPRFilesDiffViewState>()
const prFilesDiffScrollTopCache = new Map<string, number>()

function mapPRFileStatus(status: GitHubPRFile['status']): GitBranchChangeEntry['status'] {
  switch (status) {
    case 'added':
      return 'added'
    case 'removed':
      return 'deleted'
    case 'renamed':
      return 'renamed'
    case 'copied':
      return 'copied'
    default:
      return 'modified'
  }
}

function getPRFileSectionKey(path: string): string {
  return `combined-commit:${path}`
}

function gitHubPRFileToBranchEntry(file: GitHubPRFile): GitBranchChangeEntry {
  return {
    path: file.path,
    oldPath: file.oldPath,
    status: mapPRFileStatus(file.status),
    added: file.additions,
    removed: file.deletions
  }
}

function getPRFileDiffResult(contents: GitHubPRFileContents): GitDiffResult {
  if (contents.originalIsBinary) {
    return {
      kind: 'binary',
      originalContent: contents.original,
      modifiedContent: contents.modified,
      originalIsBinary: true,
      modifiedIsBinary: contents.modifiedIsBinary
    }
  }
  if (contents.modifiedIsBinary) {
    return {
      kind: 'binary',
      originalContent: contents.original,
      modifiedContent: contents.modified,
      originalIsBinary: false,
      modifiedIsBinary: true
    }
  }

  return {
    kind: 'text',
    originalContent: contents.original,
    modifiedContent: contents.modified,
    originalIsBinary: false,
    modifiedIsBinary: false
  }
}

type PRFilesCombinedDiffViewerProps = {
  files: GitHubPRFile[]
  comments: PRComment[]
  repoPath: string
  repoId: string
  prNumber: number
  prUrl: string
  headSha: string | undefined
  baseSha: string | undefined
  pendingViewedPaths: ReadonlySet<string>
  onCommentAdded: (comment: PRComment) => void
  onViewedChange: (path: string, viewed: boolean) => Promise<boolean>
}

function PRFilesCombinedDiffViewer({
  files,
  comments,
  repoPath,
  repoId,
  prNumber,
  prUrl,
  headSha,
  baseSha,
  pendingViewedPaths,
  onCommentAdded,
  onViewedChange
}: PRFilesCombinedDiffViewerProps): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const isDark =
    settings?.theme === 'dark' ||
    (settings?.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  const entriesCacheRef = useRef<{
    signature: string
    entries: GitBranchChangeEntry[]
  } | null>(null)
  const diffEntrySignature = useMemo(
    () =>
      JSON.stringify(
        files.map((file) => ({
          path: file.path,
          oldPath: file.oldPath ?? null,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          isBinary: file.isBinary
        }))
      ),
    [files]
  )
  const entries = useMemo(() => {
    if (entriesCacheRef.current?.signature === diffEntrySignature) {
      return entriesCacheRef.current.entries
    }
    const nextEntries = files.map(gitHubPRFileToBranchEntry)
    entriesCacheRef.current = { signature: diffEntrySignature, entries: nextEntries }
    return nextEntries
  }, [diffEntrySignature, files])
  const fileByPath = useMemo(() => new Map(files.map((file) => [file.path, file])), [files])
  const inlineReviewComments = useMemo<DecoratedDiffComment[]>(
    () =>
      comments.flatMap((comment): DecoratedDiffComment[] => {
        // Why: stale threads keep originalLine for the sidebar, but rendering
        // that number inline can attach the comment to unrelated current code.
        if (comment.isOutdated || !comment.path || typeof comment.line !== 'number') {
          return []
        }
        const createdAtMs = new Date(comment.createdAt).getTime()
        return [
          {
            id: `github-pr-comment:${comment.id}`,
            worktreeId: `github-pr:${repoId}:${prNumber}`,
            filePath: comment.path,
            source: 'diff',
            startLine: comment.startLine,
            lineNumber: comment.line,
            body: comment.body,
            createdAt: Number.isFinite(createdAtMs) ? createdAtMs : Date.now(),
            side: 'modified',
            author: comment.author,
            authorAvatarUrl: comment.authorAvatarUrl,
            createdAtLabel: formatRelativeTime(comment.createdAt),
            url: comment.url,
            canDelete: false,
            canEdit: false
          }
        ]
      }),
    [comments, prNumber, repoId]
  )
  const entrySignature = useMemo(
    () =>
      JSON.stringify({
        repoId,
        prNumber,
        headSha: headSha ?? null,
        baseSha: baseSha ?? null,
        files: diffEntrySignature
      }),
    [baseSha, diffEntrySignature, headSha, prNumber, repoId]
  )
  const viewStateKey = useMemo(
    () => [repoId || repoPath, prNumber].join('\0'),
    [prNumber, repoId, repoPath]
  )
  const [sections, setSections] = useState<DiffSection[]>([])
  const [sideBySide, setSideBySide] = useState(false)
  const [fileTreeCollapsed, setFileTreeCollapsed] = useState(false)
  const [sectionHeights, setSectionHeights] = useState<Record<number, number>>({})
  const [activeTreeSectionKey, setActiveTreeSectionKey] = useState<string | null>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const pendingRestoreScrollTopRef = useRef<number | null>(null)
  const loadedIndicesRef = useRef<Set<number>>(new Set())
  const loadingIndicesRef = useRef<Set<number>>(new Set())
  const sectionsRef = useRef<DiffSection[]>([])
  const generationRef = useRef(0)
  const modifiedEditorsRef = useRef<Map<number, monacoEditor.IStandaloneCodeEditor>>(new Map())
  const handleSectionSaveRef = useRef<(index: number) => Promise<void>>(async () => {})
  sectionsRef.current = sections

  useEffect(() => {
    // Why: even cached restores represent a new PR/file generation; stale async
    // diff loads from the previous view must not patch the restored sections.
    generationRef.current += 1
    const cached = prFilesDiffViewStateCache.get(viewStateKey)
    if (cached && cached.entrySignature === entrySignature) {
      const restoredSections = cached.sections
      loadedIndicesRef.current = new Set(
        cached.loadedIndices.filter((index) => !restoredSections[index]?.loading)
      )
      loadingIndicesRef.current.clear()
      setSections(restoredSections)
      setSectionHeights(cached.sectionHeights)
      setSideBySide(cached.sideBySide)
      setFileTreeCollapsed(cached.fileTreeCollapsed)
      setActiveTreeSectionKey(cached.activeTreeSectionKey)
      pendingRestoreScrollTopRef.current =
        prFilesDiffScrollTopCache.get(viewStateKey) ?? cached.scrollTop
      return
    }

    loadedIndicesRef.current.clear()
    loadingIndicesRef.current.clear()
    pendingRestoreScrollTopRef.current = prFilesDiffScrollTopCache.get(viewStateKey) ?? null
    setSectionHeights({})
    setActiveTreeSectionKey(null)
    setSections(
      entries.map((entry) => ({
        key: getPRFileSectionKey(entry.path),
        path: entry.path,
        oldPath: entry.oldPath,
        status: entry.status,
        added: entry.added,
        removed: entry.removed,
        originalContent: '',
        modifiedContent: '',
        collapsed: false,
        loading: true,
        error: undefined,
        dirty: false,
        diffResult: null
      }))
    )
  }, [entries, entrySignature, viewStateKey])

  const loadSection = useCallback(
    (index: number) => {
      const section = sectionsRef.current[index]
      if (!section || section.collapsed) {
        return
      }
      if (loadedIndicesRef.current.has(index) || loadingIndicesRef.current.has(index)) {
        return
      }
      const file = fileByPath.get(section.path)
      if (!file) {
        return
      }
      const generation = generationRef.current
      loadingIndicesRef.current.add(index)

      const load = async (): Promise<{ result: GitDiffResult; error?: string }> => {
        if (file.isBinary) {
          return {
            result: {
              kind: 'binary',
              originalContent: '',
              modifiedContent: '',
              originalIsBinary: true,
              modifiedIsBinary: true
            }
          }
        }
        if (!headSha || !baseSha) {
          return {
            result: {
              kind: 'text',
              originalContent: '',
              modifiedContent: '',
              originalIsBinary: false,
              modifiedIsBinary: false
            },
            error: 'Diff unavailable because the PR commit SHAs are missing.'
          }
        }
        const contents = await loadPRFileContents({
          repoPath,
          repoId,
          prNumber,
          file,
          headSha,
          baseSha
        })
        return { result: getPRFileDiffResult(contents) }
      }

      load()
        .catch((error) => ({
          result: {
            kind: 'text',
            originalContent: '',
            modifiedContent: '',
            originalIsBinary: false,
            modifiedIsBinary: false
          } as GitDiffResult,
          error: error instanceof Error ? error.message : 'Failed to load diff.'
        }))
        .then(({ result, error }) => {
          loadingIndicesRef.current.delete(index)
          if (generationRef.current !== generation) {
            return
          }
          loadedIndicesRef.current.add(index)
          setSections((prev) =>
            prev.map((current, currentIndex) =>
              currentIndex === index
                ? {
                    ...current,
                    diffResult: result,
                    originalContent: result.kind === 'text' ? result.originalContent : '',
                    modifiedContent: result.kind === 'text' ? result.modifiedContent : '',
                    loading: false,
                    error
                  }
                : current
            )
          )
        })
    },
    [baseSha, fileByPath, headSha, prNumber, repoId, repoPath]
  )

  const retrySection = useCallback(
    (index: number) => {
      loadedIndicesRef.current.delete(index)
      loadingIndicesRef.current.delete(index)
      setSections((prev) =>
        prev.map((section, sectionIndex) =>
          sectionIndex === index
            ? {
                ...section,
                diffResult: null,
                originalContent: '',
                modifiedContent: '',
                loading: true,
                error: undefined
              }
            : section
        )
      )
      loadSection(index)
    },
    [loadSection]
  )

  const toggleSection = useCallback(
    (index: number) => {
      const shouldLoadAfterExpand = sectionsRef.current[index]?.collapsed ?? false
      setSections((prev) =>
        prev.map((section, sectionIndex) =>
          sectionIndex === index ? { ...section, collapsed: !section.collapsed } : section
        )
      )
      if (shouldLoadAfterExpand) {
        window.requestAnimationFrame(() => loadSection(index))
      }
    },
    [loadSection]
  )

  const setAllSectionsCollapsed = useCallback(
    (collapsed: boolean) => {
      setSections((prev) => prev.map((section) => ({ ...section, collapsed })))
      if (!collapsed) {
        window.requestAnimationFrame(() => {
          sectionsRef.current.forEach((_, index) => loadSection(index))
        })
      }
    },
    [loadSection]
  )

  const allSectionsCollapsed = sections.length > 0 && sections.every((section) => section.collapsed)
  const sectionIndexByKey = useMemo(() => createCombinedDiffSectionIndexMap(sections), [sections])
  const viewedSectionKeys = useMemo(
    () => new Set(files.filter(isPRFileViewed).map((file) => getPRFileSectionKey(file.path))),
    [files]
  )

  const virtualizer = useVirtualizer({
    count: sections.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: (index) => {
      const section = sections[index]
      if (!section) {
        return 88
      }
      return getDiffSectionEstimatedHeight({
        collapsed: section.collapsed,
        measuredContentHeight: sectionHeights[index],
        originalContent: section.originalContent,
        modifiedContent: section.modifiedContent,
        changedLineCount:
          section.added === undefined && section.removed === undefined
            ? undefined
            : (section.added ?? 0) + (section.removed ?? 0),
        useIntrinsicImageHeight: isIntrinsicHeightImageDiff(section.diffResult)
      })
    },
    overscan: PR_DIFF_OVERSCAN,
    getItemKey: (index) => {
      const section = sections[index]
      return section
        ? `${section.key}:${section.collapsed ? 'collapsed' : 'expanded'}:${entrySignature}`
        : `${index}:${entrySignature}`
    }
  })

  useLayoutEffect(() => {
    virtualizer.measure()
  }, [sideBySide, virtualizer])

  useEffect(() => {
    if (sections.length === 0 && entries.length > 0) {
      return
    }
    const preservedScrollTop =
      prFilesDiffScrollTopCache.get(viewStateKey) ?? scrollContainerRef.current?.scrollTop ?? 0
    setWithLRU(prFilesDiffViewStateCache, viewStateKey, {
      entrySignature,
      sections,
      sectionHeights,
      loadedIndices: Array.from(loadedIndicesRef.current).filter(
        (index) => !sections[index]?.loading
      ),
      scrollTop: preservedScrollTop,
      sideBySide,
      fileTreeCollapsed,
      activeTreeSectionKey
    })
  }, [
    activeTreeSectionKey,
    entries.length,
    entrySignature,
    fileTreeCollapsed,
    sectionHeights,
    sections,
    sideBySide,
    viewStateKey
  ])

  useLayoutEffect(() => {
    const container = scrollContainerRef.current
    if (!container) {
      return
    }

    const updateCachedScrollPosition = (): void => {
      const existing = prFilesDiffViewStateCache.get(viewStateKey)
      setWithLRU(prFilesDiffScrollTopCache, viewStateKey, container.scrollTop)
      if (!existing || existing.entrySignature !== entrySignature) {
        return
      }
      setWithLRU(prFilesDiffViewStateCache, viewStateKey, {
        ...existing,
        scrollTop: container.scrollTop
      })
    }

    container.addEventListener('scroll', updateCachedScrollPosition)
    return () => {
      updateCachedScrollPosition()
      container.removeEventListener('scroll', updateCachedScrollPosition)
    }
  }, [entrySignature, viewStateKey])

  useLayoutEffect(() => {
    const container = scrollContainerRef.current
    const targetScrollTop = pendingRestoreScrollTopRef.current
    if (!container || targetScrollTop === null) {
      return
    }

    let frameId = 0
    let attempts = 0
    const restoreScrollPosition = (): void => {
      const liveContainer = scrollContainerRef.current
      const liveTarget = pendingRestoreScrollTopRef.current
      if (!liveContainer || liveTarget === null) {
        return
      }

      const maxScrollTop = Math.max(0, liveContainer.scrollHeight - liveContainer.clientHeight)
      const nextScrollTop = Math.min(liveTarget, maxScrollTop)
      liveContainer.scrollTop = nextScrollTop
      setWithLRU(prFilesDiffScrollTopCache, viewStateKey, nextScrollTop)

      if (Math.abs(liveContainer.scrollTop - liveTarget) <= 1 || maxScrollTop >= liveTarget) {
        pendingRestoreScrollTopRef.current = null
        return
      }

      attempts += 1
      if (attempts < 30) {
        frameId = window.requestAnimationFrame(restoreScrollPosition)
      }
    }

    restoreScrollPosition()
    return () => window.cancelAnimationFrame(frameId)
  }, [sectionHeights, sections, viewStateKey])

  const handleTreeNavigate = useCallback(
    (entry: CombinedDiffFileTreeEntry) => {
      const navigatedIndex = handleCombinedDiffFileTreeNavigation({
        mode: 'commit',
        entry,
        sections: sectionsRef.current,
        sectionIndexByKey,
        toggleSection,
        scrollToIndex: (index) => virtualizer.scrollToIndex(index, { align: 'start' })
      })
      if (navigatedIndex !== null) {
        setActiveTreeSectionKey(sectionsRef.current[navigatedIndex]?.key ?? null)
      }
    },
    [sectionIndexByKey, toggleSection, virtualizer]
  )

  const openFilesOnGitHub = useCallback(() => {
    void window.api.shell.openUrl(`${prUrl.replace(/\/$/, '')}/files`)
  }, [prUrl])

  const handleAddLineComment = useCallback(
    async (
      section: DiffSection,
      {
        lineNumber,
        startLine,
        body
      }: {
        lineNumber: number
        startLine?: number
        body: string
      }
    ) => {
      if (!headSha) {
        toast.error('Unable to comment without the PR head SHA.')
        return false
      }
      const result = await addPRReviewCommentForRepo({
        repoPath,
        repoId,
        prNumber,
        commitId: headSha,
        path: section.path,
        line: lineNumber,
        startLine,
        body
      })
      if (!result.ok) {
        toast.error(result.error || 'Failed to add review comment.')
        return false
      }
      onCommentAdded(result.comment)
      toast.success('Review comment added.')
      return true
    },
    [headSha, onCommentAdded, prNumber, repoId, repoPath]
  )

  const renderViewedCheckbox = useCallback(
    (section: DiffSection) => {
      const file = fileByPath.get(section.path)
      if (!file) {
        return null
      }
      const viewed = isPRFileViewed(file)
      const pending = pendingViewedPaths.has(file.path)
      return (
        <PRViewedCheckbox
          checked={viewed}
          pending={pending}
          filePath={file.path}
          onToggle={() => {
            if (!pending) {
              void onViewedChange(file.path, !viewed)
            }
          }}
        />
      )
    },
    [fileByPath, onViewedChange, pendingViewedPaths]
  )

  return (
    <div className="flex min-h-[520px] flex-1 flex-col">
      <div className="sticky top-0 z-20 flex shrink-0 items-center justify-between gap-3 border-b border-border bg-background px-3 py-1.5">
        <div className="flex min-w-0 items-center gap-2">
          {fileTreeCollapsed && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Show file tree"
                  onClick={() => setFileTreeCollapsed(false)}
                >
                  <PanelLeftOpen className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={6}>
                Show file tree
              </TooltipContent>
            </Tooltip>
          )}
          <span className="truncate text-xs text-muted-foreground">
            {files.filter(isPRFileViewed).length} / {files.length} files viewed
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            className="w-20 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => setAllSectionsCollapsed(!allSectionsCollapsed)}
          >
            {allSectionsCollapsed ? 'Expand All' : 'Collapse All'}
          </button>
          <button
            type="button"
            className="w-24 rounded border border-border px-2 py-0.5 text-center text-xs text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => setSideBySide((prev) => !prev)}
          >
            {sideBySide ? 'Inline' : 'Side by Side'}
          </button>
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        <CombinedDiffFileTree
          mode="commit"
          worktreePath={repoPath}
          entries={entries}
          sectionIndexByKey={sectionIndexByKey}
          activeSectionKey={activeTreeSectionKey}
          viewedSectionKeys={viewedSectionKeys}
          collapsed={fileTreeCollapsed}
          onCollapsedChange={setFileTreeCollapsed}
          onNavigate={handleTreeNavigate}
        />
        <div ref={scrollContainerRef} className="min-w-0 flex-1 overflow-auto scrollbar-editor">
          <div className="relative w-full" style={{ height: `${virtualizer.getTotalSize()}px` }}>
            {virtualizer.getVirtualItems().map((virtualItem) => {
              const section = sections[virtualItem.index]
              if (!section) {
                return null
              }
              return (
                <div
                  key={virtualItem.key}
                  data-index={virtualItem.index}
                  ref={virtualizer.measureElement}
                  className="absolute left-0 top-0 w-full"
                  style={{ top: `${virtualItem.start}px` }}
                >
                  <DiffSectionItem
                    section={section}
                    index={virtualItem.index}
                    isBranchMode={false}
                    sideBySide={sideBySide}
                    isDark={isDark}
                    settings={settings}
                    sectionHeight={sectionHeights[virtualItem.index]}
                    worktreeId={`github-pr:${repoId}:${prNumber}`}
                    inlineComments={inlineReviewComments}
                    loadSection={loadSection}
                    retrySection={retrySection}
                    toggleSection={toggleSection}
                    openSection={openFilesOnGitHub}
                    openSectionTitle="Open files on GitHub"
                    renderHeaderTrailingContent={renderViewedCheckbox}
                    onAddLineComment={handleAddLineComment}
                    addLineCommentLabel="Comment"
                    addLineCommentPlaceholder="Add a review comment"
                    getCommentableLineNumbers={(section) =>
                      fileByPath.get(section.path)?.reviewCommentLineNumbers
                    }
                    setSectionHeights={setSectionHeights}
                    setSections={setSections}
                    modifiedEditorsRef={modifiedEditorsRef}
                    handleSectionSaveRef={handleSectionSaveRef}
                  />
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}

function CommentCodeContext({
  comment,
  repoPath,
  repoId,
  prNumber,
  files,
  headSha,
  baseSha
}: {
  comment: PRComment
  repoPath: string | null
  repoId: string
  prNumber: number
  files: GitHubPRFile[]
  headSha: string | undefined
  baseSha: string | undefined
}): React.JSX.Element | null {
  const [contents, setContents] = useState<GitHubPRFileContents | null>(null)
  const [error, setError] = useState(false)
  const [contextBefore, setContextBefore] = useState(0)
  const [contextAfter, setContextAfter] = useState(0)
  const file = useMemo(
    () => files.find((candidate) => candidate.path === comment.path),
    [comment.path, files]
  )
  const line = comment.line
  const startLine = comment.startLine ?? line

  useEffect(() => {
    setContents(null)
    setError(false)
    if (!repoPath || !file || !headSha || !baseSha || !line || file.isBinary) {
      return
    }
    let cancelled = false
    loadPRFileContents({ repoPath, repoId, prNumber, file, headSha, baseSha })
      .then((result) => {
        if (!cancelled) {
          setContents(result)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError(true)
        }
      })
    return () => {
      cancelled = true
    }
  }, [baseSha, file, headSha, line, prNumber, repoId, repoPath])

  useEffect(() => {
    setContextBefore(0)
    setContextAfter(0)
  }, [comment.id])

  if (!comment.path || !line || !file || file.isBinary || error) {
    return null
  }

  if (!contents) {
    return (
      <div className="mb-3 flex items-center gap-2 rounded-md border border-border/40 bg-muted/20 px-3 py-2 text-[12px] text-muted-foreground">
        <LoaderCircle className="size-3.5 animate-spin" />
        Loading code context…
      </div>
    )
  }

  const source = contents.modified || contents.original
  const lines = source.split(/\r?\n/)
  const language = detectLanguage(comment.path)
  const commentFrom = Math.max(1, Math.min(startLine ?? line, line))
  const commentTo = Math.min(lines.length, Math.max(startLine ?? line, line))
  const from = Math.max(1, commentFrom - contextBefore)
  const to = Math.min(lines.length, commentTo + contextAfter)
  const selectedLines = lines.slice(from - 1, to)
  const candidateBlockRange = findNearestBraceBlock(lines, commentFrom)
  const candidateBlockLineCount = candidateBlockRange
    ? candidateBlockRange.endLine - candidateBlockRange.startLine + 1
    : 0
  const isWholeFileBlock =
    candidateBlockRange !== null &&
    candidateBlockRange.startLine <= 2 &&
    candidateBlockRange.endLine >= lines.length - 1
  const shouldUseBlockRange =
    candidateBlockRange !== null &&
    !isWholeFileBlock &&
    candidateBlockLineCount <= CODE_CONTEXT_MAX_BLOCK_LINES
  const blockRange = shouldUseBlockRange
    ? candidateBlockRange
    : {
        startLine: Math.max(1, commentFrom - CODE_CONTEXT_FALLBACK_LINES),
        endLine: Math.min(lines.length, commentTo + CODE_CONTEXT_FALLBACK_LINES)
      }
  const canExpandAbove = from > 1
  const canExpandBelow = to < lines.length
  const canExpandBlock = blockRange.startLine < from || blockRange.endLine > to
  const blockTooltip = shouldUseBlockRange
    ? 'Show surrounding code block'
    : 'Show nearby code context'

  if (selectedLines.length === 0) {
    return null
  }

  return (
    <div className="mb-3 overflow-hidden rounded-md border border-border/50 bg-muted/20">
      <div className="flex flex-wrap items-center gap-2 border-b border-border/40 px-3 py-1.5 text-[11px] text-muted-foreground">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="truncate font-mono">{comment.path}</span>
          <span className="shrink-0 font-mono">
            L{from}
            {to !== from ? `-L${to}` : ''}
          </span>
          {(from !== commentFrom || to !== commentTo) && (
            <span className="shrink-0 font-mono text-muted-foreground/70">
              comment L{commentFrom}
              {commentTo !== commentFrom ? `-L${commentTo}` : ''}
            </span>
          )}
        </div>
        <ButtonGroup className="text-muted-foreground" aria-label="Code context controls">
          {(contextBefore > 0 || contextAfter > 0) && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="icon-xs"
                  className="size-7 border-border/55 bg-background/35 text-muted-foreground shadow-none hover:bg-accent hover:text-accent-foreground"
                  onClick={() => {
                    setContextBefore(0)
                    setContextAfter(0)
                  }}
                  aria-label="Reset code context"
                >
                  <UndoDot className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Reset code context</TooltipContent>
            </Tooltip>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="icon-xs"
                className="size-7 border-border/55 bg-background/35 text-muted-foreground shadow-none hover:bg-accent hover:text-accent-foreground"
                disabled={!canExpandAbove}
                onClick={() =>
                  setContextBefore((current) =>
                    Math.min(current + CODE_CONTEXT_EXPAND_STEP, commentFrom - 1)
                  )
                }
                aria-label={`Show ${CODE_CONTEXT_EXPAND_STEP} more lines above`}
              >
                <ArrowUp className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Show more lines above</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="icon-xs"
                className="size-7 border-border/55 bg-background/35 text-muted-foreground shadow-none hover:bg-accent hover:text-accent-foreground"
                disabled={!canExpandBelow}
                onClick={() =>
                  setContextAfter((current) =>
                    Math.min(current + CODE_CONTEXT_EXPAND_STEP, lines.length - commentTo)
                  )
                }
                aria-label={`Show ${CODE_CONTEXT_EXPAND_STEP} more lines below`}
              >
                <ArrowDown className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Show more lines below</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="icon-xs"
                className="size-7 border-border/55 bg-background/35 text-muted-foreground shadow-none hover:bg-accent hover:text-accent-foreground"
                disabled={!canExpandBlock}
                onClick={() => {
                  setContextBefore((current) =>
                    Math.max(current, Math.max(0, commentFrom - blockRange.startLine))
                  )
                  setContextAfter((current) =>
                    Math.max(current, Math.max(0, blockRange.endLine - commentTo))
                  )
                }}
                aria-label={blockTooltip}
              >
                <Braces className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{blockTooltip}</TooltipContent>
          </Tooltip>
        </ButtonGroup>
      </div>
      <Suspense
        fallback={
          <pre className="overflow-x-auto py-1 text-[12px] leading-5">
            {selectedLines.map((codeLine, index) => {
              const lineNumber = from + index
              const isCommentedLine = lineNumber >= commentFrom && lineNumber <= commentTo
              return (
                <div
                  key={lineNumber}
                  className={cn('flex font-mono', isCommentedLine && 'bg-emerald-500/10')}
                >
                  <span className="w-12 shrink-0 select-none border-r border-border/40 px-2 text-right text-muted-foreground">
                    {lineNumber}
                  </span>
                  <code className="min-w-0 flex-1 px-3 text-foreground">{codeLine || ' '}</code>
                </div>
              )
            })}
          </pre>
        }
      >
        <MonacoCodeExcerpt
          lines={selectedLines}
          firstLineNumber={from}
          highlightedStartLine={commentFrom}
          highlightedEndLine={commentTo}
          language={language}
        />
      </Suspense>
    </div>
  )
}

function ConversationTab({
  item,
  repoPath,
  body,
  comments,
  files,
  headSha,
  baseSha,
  loading,
  detailsLoaded,
  checks,
  participants: detailsParticipants,
  localState,
  onStateChange,
  projectOrigin,
  onMutated,
  onChecksUpdated,
  onBodyUpdated,
  onCommentAdded,
  onReviewersRequested
}: {
  item: GitHubWorkItem
  repoPath: string | null
  repoId: string | null
  body: string
  comments: PRComment[]
  files: GitHubPRFile[]
  headSha: string | undefined
  baseSha: string | undefined
  loading: boolean
  detailsLoaded: boolean
  checks: GitHubWorkItemDetails['checks']
  participants: GitHubAssignableUser[]
  localState: GitHubWorkItem['state']
  onStateChange: (state: GitHubWorkItem['state']) => void
  projectOrigin: PullRequestPageProjectOrigin | undefined
  onMutated: () => void
  onChecksUpdated: (checks: PRCheckDetail[]) => void
  onBodyUpdated: (body: string) => void
  onCommentAdded: (comment: PRComment) => void
  onReviewersRequested: (reviewRequests: GitHubAssignableUser[]) => void
}): React.JSX.Element {
  const authorLabel = item.author ?? 'unknown'
  const [replyingTo, setReplyingTo] = useState<number | null>(null)
  const [commentFilter, setCommentFilter] = useState<PRCommentAudienceFilter>('all')
  const [bodyDraft, setBodyDraft] = useState(body)
  const [bodyEditing, setBodyEditing] = useState(false)
  const [bodySaving, setBodySaving] = useState(false)
  const bodyTextareaRef = useRef<HTMLTextAreaElement>(null)
  const bodyTextareaFocusFrameRef = useRef<number | null>(null)
  const repoAssignees = useRepoAssignees(repoPath, item.repoId)
  const commentCounts = useMemo(() => getPRCommentAudienceCounts(comments), [comments])
  const visibleComments = useMemo(
    () => filterPRCommentsByAudience(comments, commentFilter),
    [commentFilter, comments]
  )
  const visibleCommentGroups = useMemo(() => groupPRComments(visibleComments), [visibleComments])
  const mentionOptions = useMemo(
    () =>
      buildMentionOptions({
        item,
        comments,
        participants: detailsParticipants,
        assignableUsers: repoAssignees.data
      }),
    [comments, detailsParticipants, item, repoAssignees.data]
  )

  const cancelBodyTextareaFocusFrame = useCallback((): void => {
    if (bodyTextareaFocusFrameRef.current !== null) {
      cancelAnimationFrame(bodyTextareaFocusFrameRef.current)
      bodyTextareaFocusFrameRef.current = null
    }
  }, [])

  useEffect(() => {
    if (replyingTo !== null && !visibleComments.some((comment) => comment.id === replyingTo)) {
      setReplyingTo(null)
    }
  }, [replyingTo, visibleComments])

  useEffect(() => {
    if (!bodyEditing) {
      setBodyDraft(body)
    }
  }, [body, bodyEditing, item.id])

  useEffect(() => {
    if (!bodyEditing) {
      cancelBodyTextareaFocusFrame()
      return cancelBodyTextareaFocusFrame
    }
    cancelBodyTextareaFocusFrame()
    bodyTextareaFocusFrameRef.current = requestAnimationFrame(() => {
      bodyTextareaFocusFrameRef.current = null
      bodyTextareaRef.current?.focus()
    })
    return cancelBodyTextareaFocusFrame
  }, [bodyEditing, cancelBodyTextareaFocusFrame])

  const bodySlug = useMemo(() => parseOwnerRepoFromItemUrl(item.url), [item.url])
  const markdownGitHubRepo = useMemo(
    () => (projectOrigin ? { owner: projectOrigin.owner, repo: projectOrigin.repo } : bodySlug),
    [bodySlug, projectOrigin]
  )
  const canEditBody =
    item.type === 'pr' ? Boolean(projectOrigin || bodySlug) : Boolean(projectOrigin || repoPath)
  const bodyChanged = bodyDraft !== body

  const handleSaveBody = useCallback(async (): Promise<void> => {
    if (bodySaving || !bodyChanged) {
      setBodyEditing(false)
      return
    }
    setBodySaving(true)
    try {
      await runWorkItemBodyUpdate({
        item,
        repoPath,
        projectOrigin,
        body: bodyDraft,
        parsedSlug: bodySlug
      })
      onBodyUpdated(bodyDraft)
      setBodyEditing(false)
      toast.success('Description updated.')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update description.')
    } finally {
      setBodySaving(false)
    }
  }, [bodyChanged, bodyDraft, bodySaving, bodySlug, item, onBodyUpdated, projectOrigin, repoPath])

  const handleReply = useCallback(
    async (comment: PRComment, replyBody: string): Promise<boolean> => {
      if (!repoPath) {
        toast.error('Unable to reply without a repository path.')
        return false
      }
      const result =
        comment.path && item.type === 'pr'
          ? await addPRReviewCommentReplyForRepo({
              repoPath,
              repoId: item.repoId,
              prNumber: item.number,
              commentId: comment.id,
              body: replyBody,
              threadId: comment.threadId,
              path: comment.path,
              line: comment.line
            })
          : await addIssueCommentForRepo({
              repoPath,
              repoId: item.repoId,
              number: item.number,
              body: `@${comment.author} ${replyBody}`,
              type: item.type
            })

      if (!result.ok) {
        toast.error(result.error || 'Failed to post reply.')
        return false
      }
      onCommentAdded(result.comment)
      setReplyingTo(null)
      toast.success('Reply posted.')
      return true
    },
    [item.number, item.repoId, item.type, onCommentAdded, repoPath]
  )

  const rightPanel =
    item.type === 'pr' ? (
      <div className="flex h-fit flex-col gap-3 xl:sticky xl:top-4">
        <PRActionsPanel
          item={item}
          repoPath={repoPath}
          repoId={item.repoId}
          projectOrigin={projectOrigin}
          localState={localState}
          onStateChange={onStateChange}
          onMutated={onMutated}
        />
        <PRReviewersPanel
          item={item}
          loading={loading}
          repoPath={repoPath}
          onReviewersRequested={onReviewersRequested}
        />
        <aside className="overflow-hidden rounded-lg border border-border/50 bg-card shadow-xs">
          <ChecksTab
            item={item}
            repoPath={repoPath}
            repoId={item.repoId}
            headSha={headSha}
            checks={checks}
            loading={loading || !detailsLoaded}
            onChecksUpdated={onChecksUpdated}
          />
        </aside>
      </div>
    ) : null

  const renderCommentCard = (comment: PRComment, isReply = false): React.JSX.Element => (
    <div
      key={comment.id}
      className={cn(
        'min-w-0 overflow-hidden rounded-lg border border-border/40 bg-card shadow-xs',
        isReply && 'ml-6 max-w-[calc(100%-1.5rem)]',
        comment.isResolved && PR_COMMENT_RESOLVED_CONTAINER_CLASS
      )}
    >
      <div className="flex min-w-0 items-center gap-2 border-b border-border/40 px-3 py-2">
        {comment.authorAvatarUrl ? (
          <img
            src={comment.authorAvatarUrl}
            alt={comment.author}
            className="size-5 shrink-0 rounded-full"
          />
        ) : (
          <div className="size-5 shrink-0 rounded-full bg-muted" />
        )}
        <span
          className={cn(
            'min-w-0 truncate text-[13px] font-semibold',
            comment.isResolved ? PR_COMMENT_RESOLVED_AUTHOR_CLASS : PR_COMMENT_OPEN_AUTHOR_CLASS
          )}
        >
          {comment.author}
        </span>
        <span className="shrink-0 text-[12px] text-muted-foreground">
          · {formatRelativeTime(comment.createdAt)}
        </span>
        {comment.path && (
          <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground/70">
            {comment.path.split('/').pop()}
            {comment.line ? `:L${comment.line}` : ''}
          </span>
        )}
        {comment.isResolved && (
          <span className="rounded-full border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[11px] text-muted-foreground">
            resolved
          </span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                className="size-7"
                onClick={() =>
                  setReplyingTo((current) => (current === comment.id ? null : comment.id))
                }
                aria-label="Reply to comment"
              >
                <MessageSquarePlus className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Reply to comment</TooltipContent>
          </Tooltip>
          {comment.url && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="size-7"
                  onClick={() => window.api.shell.openUrl(comment.url)}
                  aria-label="Open comment on GitHub"
                >
                  <ExternalLink className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Open comment on GitHub</TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>
      <div className="min-w-0 px-3 py-2">
        <CommentCodeContext
          comment={comment}
          repoPath={repoPath}
          repoId={item.repoId}
          prNumber={item.number}
          files={files}
          headSha={headSha}
          baseSha={baseSha}
        />
        <CommentMarkdown
          content={comment.body}
          variant="document"
          githubRepo={markdownGitHubRepo}
          className="min-w-0 max-w-full overflow-hidden break-words text-[13px] leading-relaxed [&_a]:break-all [&_code]:break-words [&_pre]:max-w-full"
        />
        <CommentReactions reactions={comment.reactions} />
        {replyingTo === comment.id && (
          <CommentReplyForm
            className="mt-3"
            placeholder={
              comment.path ? 'Reply in this review thread' : `Reply to @${comment.author}`
            }
            mentionOptions={mentionOptions}
            onCancel={() => setReplyingTo(null)}
            onSubmit={(replyBody) => handleReply(comment, replyBody)}
          />
        )}
      </div>
    </div>
  )

  const renderCommentGroup = (group: PRCommentGroup): React.JSX.Element => {
    const cards =
      group.kind === 'thread'
        ? [
            renderCommentCard(group.root),
            ...group.replies.map((reply) => renderCommentCard(reply, true))
          ]
        : [renderCommentCard(group.comment)]

    if (!isResolvedPRCommentGroup(group)) {
      return (
        <div key={getPRCommentGroupId(group)} className="flex min-w-0 flex-col gap-3">
          {cards}
        </div>
      )
    }

    const root = getPRCommentGroupRoot(group)
    const count = getPRCommentGroupCount(group)
    return (
      <Accordion key={getPRCommentGroupId(group)} type="single" collapsible>
        <AccordionItem
          value={getPRCommentGroupId(group)}
          className="rounded-lg border border-border/40 bg-card"
        >
          <AccordionTrigger className="px-3 py-2 text-[13px] text-muted-foreground hover:bg-accent/30">
            <span className="min-w-0 truncate">
              Resolved {group.kind === 'thread' ? 'thread' : 'comment'} by {root.author}
              {count > 1 ? ` (${count})` : ''}
            </span>
          </AccordionTrigger>
          <AccordionContent className="flex min-w-0 flex-col gap-3 px-3 pb-3 pt-0">
            {cards}
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    )
  }

  return (
    <div
      className={cn(
        'grid min-w-0 gap-5 px-4 py-4',
        // Why: the drawer expands nearly full-width on narrow app windows, so
        // keep PR controls beside the conversation instead of hiding them below
        // long review threads.
        item.type === 'pr' && 'grid-cols-[minmax(0,1fr)_300px]'
      )}
    >
      <div className="flex min-w-0 flex-col gap-4">
        <div className="rounded-lg border border-border/50 bg-card shadow-xs">
          <div className="flex items-center gap-2 border-b border-border/50 px-3 py-2 text-[12px] text-muted-foreground">
            <span className="font-medium text-foreground">{authorLabel}</span>
            <span>updated {formatRelativeTime(item.updatedAt)}</span>
            {canEditBody && !loading && detailsLoaded ? (
              bodyEditing ? (
                <div className="ml-auto flex items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    className="gap-1.5"
                    disabled={bodySaving}
                    onClick={() => {
                      setBodyDraft(body)
                      setBodyEditing(false)
                    }}
                  >
                    <X className="size-3.5" />
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    size="xs"
                    className="gap-1.5"
                    disabled={bodySaving || !bodyChanged}
                    onClick={() => void handleSaveBody()}
                  >
                    {bodySaving ? (
                      <LoaderCircle className="size-3.5 animate-spin" />
                    ) : (
                      <Check className="size-3.5" />
                    )}
                    Save
                  </Button>
                </div>
              ) : (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      className="ml-auto size-7"
                      onClick={() => {
                        setBodyDraft(body)
                        setBodyEditing(true)
                      }}
                      aria-label="Edit description"
                    >
                      <Pencil className="size-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Edit description</TooltipContent>
                </Tooltip>
              )
            ) : null}
          </div>
          <div className="px-4 py-4 text-[14px] leading-relaxed text-foreground">
            {loading && !detailsLoaded ? (
              <div className="flex items-center justify-center py-5">
                <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
              </div>
            ) : bodyEditing ? (
              <MentionTextarea
                textareaRef={bodyTextareaRef}
                value={bodyDraft}
                onValueChange={setBodyDraft}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault()
                    setBodyDraft(body)
                    setBodyEditing(false)
                    return
                  }
                  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault()
                    void handleSaveBody()
                  }
                }}
                placeholder="Description"
                rows={12}
                mentionOptions={mentionOptions}
                wrapperClassName="flex min-h-64 w-full items-stretch"
                className="scrollbar-sleek block min-h-64 w-full resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-[13px] leading-5 placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            ) : body.trim() ? (
              <CommentMarkdown
                content={body}
                variant="document"
                githubRepo={markdownGitHubRepo}
                className="min-w-0 max-w-full overflow-hidden break-words text-[14px] leading-relaxed [&_a]:break-all [&_code]:break-words [&_pre]:max-w-full"
              />
            ) : (
              <span className="italic text-muted-foreground">No description provided.</span>
            )}
          </div>
        </div>

        {detailsLoaded ? (
          <>
            <div className="flex items-center gap-2 pt-1">
              <MessageSquare className="size-4 text-muted-foreground" />
              <span className="text-[13px] font-medium text-foreground">Comments</span>
              {comments.length > 0 && (
                <span className="rounded-full border border-border/50 bg-muted/30 px-1.5 py-0.5 text-[11px] tabular-nums text-muted-foreground">
                  {comments.length}
                </span>
              )}
            </div>

            {item.type === 'pr' && comments.length > 0 && (
              <div className="grid grid-cols-3 rounded-lg border border-border/50 bg-background p-0.5">
                {PR_COMMENT_AUDIENCE_FILTERS.map((filter) => {
                  const isActive = commentFilter === filter.value
                  return (
                    <button
                      key={filter.value}
                      type="button"
                      className={cn(
                        'flex h-8 items-center justify-center gap-1 rounded-md px-2 text-[12px] font-medium text-muted-foreground transition-colors',
                        isActive && 'bg-muted text-foreground'
                      )}
                      aria-pressed={isActive}
                      onClick={() => setCommentFilter(filter.value)}
                    >
                      <span>{filter.label}</span>
                      <span className="tabular-nums">{commentCounts[filter.value]}</span>
                    </button>
                  )
                })}
              </div>
            )}

            {comments.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border/50 px-3 py-6 text-left text-[13px] text-muted-foreground">
                No comments yet.
              </div>
            ) : visibleComments.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border/50 px-3 py-6 text-center text-[13px] text-muted-foreground">
                {getPRCommentAudienceEmptyLabel(commentFilter)}
              </div>
            ) : (
              <div className="flex min-w-0 flex-col gap-3">
                {visibleCommentGroups.map(renderCommentGroup)}
              </div>
            )}
          </>
        ) : null}

        {detailsLoaded && repoPath && (
          <GHCommentComposer
            className="mt-1"
            repoPath={repoPath}
            repoId={item.repoId}
            issueNumber={item.number}
            itemType={item.type}
            mentionOptions={mentionOptions}
            onCommentAdded={onCommentAdded}
          />
        )}
      </div>

      {rightPanel}
    </div>
  )
}

function PRActionsPanel({
  item,
  repoPath,
  repoId,
  projectOrigin,
  localState,
  onStateChange,
  onMutated
}: {
  item: GitHubWorkItem
  repoPath: string | null
  repoId: string | null
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
  const canMutateState = localState !== 'merged' && (!!repoPath || !!projectOrigin)
  const nextState: 'open' | 'closed' = localState === 'closed' ? 'open' : 'closed'
  const mergeDisabled = !repoPath || mergePending || !mergePresentation.directMergeAvailable

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
      patchWorkItem(item.id, { state }, item.repoId)
      patchProjectRowIfNeeded(state)
    },
    [item.id, item.repoId, onStateChange, patchProjectRowIfNeeded, patchWorkItem]
  )

  const handleStateChange = async (): Promise<void> => {
    if (!canMutateState || statePending) {
      return
    }
    const label = nextState === 'closed' ? 'Close' : 'Reopen'
    const confirmed = await confirm({
      title: `${label} PR #${item.number}?`,
      description:
        nextState === 'closed'
          ? 'This will close the pull request on GitHub.'
          : 'This will reopen the pull request on GitHub.',
      confirmLabel: label,
      confirmVariant: nextState === 'closed' ? 'destructive' : 'default'
    })
    if (!confirmed) {
      return
    }
    const previousState = localState
    setStatePending(true)
    applyStatePatch(nextState)
    try {
      await runPullRequestStateUpdate({
        repoPath,
        repoId,
        projectOrigin,
        number: item.number,
        updates: { state: nextState }
      })
      toast.success(nextState === 'closed' ? 'Pull request closed' : 'Pull request reopened')
      onMutated()
    } catch (err) {
      applyStatePatch(previousState)
      toast.error(err instanceof Error ? err.message : `Failed to ${label.toLowerCase()} PR`)
    } finally {
      setStatePending(false)
    }
  }

  const handleMerge = async (method: 'merge' | 'squash' | 'rebase'): Promise<void> => {
    if (!repoPath || mergeDisabled) {
      return
    }
    const label =
      method === 'squash' ? 'Squash and merge' : method === 'rebase' ? 'Rebase and merge' : 'Merge'
    const confirmed = await confirm({
      title: `${label} PR #${item.number}?`,
      description: 'This will update the pull request on GitHub.',
      confirmLabel: label
    })
    if (!confirmed) {
      return
    }
    setMergePending(true)
    try {
      const result = await window.api.gh.mergePR({
        repoPath,
        repoId: repoId ?? undefined,
        prNumber: item.number,
        method,
        prRepo: item.prRepo ?? null
      })
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      applyStatePatch('merged')
      toast.success('Pull request merged')
      onMutated()
    } catch {
      toast.error('Failed to merge pull request')
    } finally {
      setMergePending(false)
    }
  }

  const handleAutoMerge = async (): Promise<void> => {
    if (!repoPath || !mergePresentation.autoMergeAction) {
      return
    }
    const enabled = mergePresentation.autoMergeAction.kind === 'enable'
    setMergePending(true)
    try {
      const result = await window.api.gh.setPRAutoMerge({
        repoPath,
        repoId: repoId ?? undefined,
        prNumber: item.number,
        enabled,
        prRepo: item.prRepo ?? null
      })
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(enabled ? 'Auto-merge enabled' : 'Auto-merge disabled')
      onMutated()
    } catch {
      toast.error(enabled ? 'Failed to enable auto-merge' : 'Failed to disable auto-merge')
    } finally {
      setMergePending(false)
    }
  }

  return (
    <aside className="rounded-lg border border-border/50 bg-card p-3 shadow-xs">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <GitPullRequest className="size-3.5 text-muted-foreground" />
          <span className="text-[13px] font-medium text-foreground">Pull request</span>
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
                    (mergePresentation.directMergeAvailable ? 'Merge' : mergePresentation.label)}
                  <ChevronDown className="size-3 opacity-60" />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {!repoPath ? 'Merge requires a registered local repo' : mergePresentation.tooltip}
            </TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="start" className="w-52">
            {mergePresentation.autoMergeAction && (
              <DropdownMenuItem
                disabled={!repoPath || mergePending}
                onSelect={() => void handleAutoMerge()}
              >
                <GitMerge className="size-4" />
                {mergePresentation.autoMergeAction.label}
              </DropdownMenuItem>
            )}
            {mergePresentation.autoMergeAction && <DropdownMenuSeparator />}
            <DropdownMenuItem disabled={mergeDisabled} onSelect={() => void handleMerge('squash')}>
              <GitMerge className="size-4" />
              Squash and merge
            </DropdownMenuItem>
            <DropdownMenuItem disabled={mergeDisabled} onSelect={() => void handleMerge('merge')}>
              <GitMerge className="size-4" />
              Create merge commit
            </DropdownMenuItem>
            <DropdownMenuItem disabled={mergeDisabled} onSelect={() => void handleMerge('rebase')}>
              <GitMerge className="size-4" />
              Rebase and merge
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => window.api.shell.openUrl(item.url)}>
              <ExternalLink className="size-4" />
              Open GitHub merge box
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
          onClick={() => void handleStateChange()}
        >
          {statePending ? (
            <LoaderCircle className="size-3.5 animate-spin" />
          ) : nextState === 'closed' ? (
            <GitPullRequestClosed className="size-3.5 text-destructive" />
          ) : (
            <CircleDot className="size-3.5" />
          )}
          {nextState === 'closed' ? 'Close pull request' : 'Reopen PR'}
        </Button>
      </div>
    </aside>
  )
}

function CommentReactions({
  reactions
}: {
  reactions?: GitHubReaction[]
}): React.JSX.Element | null {
  const visibleReactions = (reactions ?? []).filter((reaction) => reaction.count > 0)
  if (visibleReactions.length === 0) {
    return null
  }

  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {visibleReactions.map((reaction) => (
        <span
          key={reaction.content}
          className="inline-flex h-6 items-center gap-1 rounded-full border border-border/60 bg-muted/35 px-2 text-[12px] leading-none text-foreground"
          aria-label={`${reaction.count} ${reaction.content} reaction${reaction.count === 1 ? '' : 's'}`}
        >
          <span aria-hidden="true">{REACTION_EMOJI[reaction.content]}</span>
          <span className="tabular-nums">{reaction.count}</span>
        </span>
      ))}
    </div>
  )
}

function CommentReplyForm({
  className,
  placeholder,
  mentionOptions,
  onCancel,
  onSubmit
}: {
  className?: string
  placeholder: string
  mentionOptions: MentionOption[]
  onCancel: () => void
  onSubmit: (body: string) => Promise<boolean>
}): React.JSX.Element {
  const [body, setBody] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    textareaRef.current?.focus()
  }, [])

  const submit = useCallback(async () => {
    const trimmed = body.trim()
    if (!trimmed || submitting) {
      return
    }
    setSubmitting(true)
    try {
      const ok = await onSubmit(trimmed)
      if (ok) {
        setBody('')
      }
    } finally {
      setSubmitting(false)
    }
  }, [body, onSubmit, submitting])

  return (
    <div className={cn('rounded-md border border-border/50 bg-background/60 p-2', className)}>
      <MentionTextarea
        textareaRef={textareaRef}
        value={body}
        onValueChange={setBody}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            onCancel()
            return
          }
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            void submit()
          }
        }}
        placeholder={placeholder}
        rows={3}
        mentionOptions={mentionOptions}
        className="scrollbar-sleek min-h-20 w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-[13px] placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
      <div className="mt-2 flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" disabled={!body.trim() || submitting} onClick={() => void submit()}>
          {submitting ? 'Posting…' : 'Reply'}
        </Button>
      </div>
    </div>
  )
}

const CHECK_SORT_ORDER: Record<string, number> = {
  failure: 0,
  timed_out: 0,
  cancelled: 1,
  pending: 2,
  neutral: 3,
  skipped: 4,
  success: 5
}

function getCheckConclusion(check: PRCheckDetail): NonNullable<PRCheckDetail['conclusion']> {
  return check.conclusion ?? 'pending'
}

function getCheckStatusLabel(check: PRCheckDetail): string {
  const conclusion = getCheckConclusion(check)
  if (conclusion === 'success') {
    return 'Successful'
  }
  if (conclusion === 'failure') {
    return 'Failed'
  }
  if (conclusion === 'cancelled') {
    return 'Cancelled'
  }
  if (conclusion === 'timed_out') {
    return 'Timed out'
  }
  if (conclusion === 'neutral') {
    return 'Neutral'
  }
  if (conclusion === 'skipped') {
    return 'Skipped'
  }
  if (check.status === 'queued') {
    return 'Queued'
  }
  if (check.status === 'in_progress') {
    return 'In progress'
  }
  return 'Pending'
}

function getCheckCounts(checks: PRCheckDetail[]): {
  passing: number
  failing: number
  pending: number
  skipped: number
  neutral: number
} {
  return checks.reduce(
    (counts, check) => {
      const conclusion = getCheckConclusion(check)
      if (conclusion === 'success') {
        counts.passing += 1
      } else if (['failure', 'cancelled', 'timed_out'].includes(conclusion)) {
        counts.failing += 1
      } else if (conclusion === 'skipped') {
        counts.skipped += 1
      } else if (conclusion === 'neutral') {
        counts.neutral += 1
      } else {
        counts.pending += 1
      }
      return counts
    },
    { passing: 0, failing: 0, pending: 0, skipped: 0, neutral: 0 }
  )
}

function getChecksSummaryLabel(checks: PRCheckDetail[]): string {
  const counts = getCheckCounts(checks)
  if (checks.length === 0) {
    return 'No checks found'
  }
  if (counts.failing > 0) {
    return `${counts.failing} ${counts.failing === 1 ? 'check' : 'checks'} failing`
  }
  if (counts.pending > 0) {
    return `${counts.pending} ${counts.pending === 1 ? 'check' : 'checks'} pending`
  }
  if (counts.passing === checks.length) {
    return 'All checks passing'
  }
  return `${counts.passing} of ${checks.length} checks passing`
}

function getBrokenChecks(checks: PRCheckDetail[]): PRCheckDetail[] {
  return checks.filter((check) =>
    ['failure', 'cancelled', 'timed_out'].includes(getCheckConclusion(check))
  )
}

function buildFixBrokenChecksPrompt(item: GitHubWorkItem, checks: PRCheckDetail[]): string {
  const brokenChecks = getBrokenChecks(checks)
  const checkLines =
    brokenChecks.length > 0
      ? brokenChecks.map((check) => {
          const details = [
            getCheckStatusLabel(check),
            check.checkRunId ? `check run ${check.checkRunId}` : null,
            check.workflowRunId ? `workflow run ${check.workflowRunId}` : null,
            check.url ? `details: ${check.url}` : null
          ]
            .filter(Boolean)
            .join(', ')
          return `- ${check.name}${details ? ` (${details})` : ''}`
        })
      : ['- No failing check is currently listed; refresh PR checks first, then inspect CI.']

  return [
    `Fix the broken checks for PR #${item.number}: ${item.title}`,
    `PR: ${item.url}`,
    '',
    'Broken checks:',
    ...checkLines,
    '',
    'Focus only on making the failing checks pass. Inspect the CI output first, make the smallest correct code or test changes, and do not work on unrelated cleanup.'
  ].join('\n')
}

function pickDefaultAgent(
  defaultAgent: TuiAgent | 'blank' | null | undefined,
  detectedAgents: TuiAgent[],
  disabledAgents?: TuiAgent[]
): TuiAgent | null {
  const enabledAgents = filterEnabledTuiAgents(detectedAgents, disabledAgents)
  if (defaultAgent && defaultAgent !== 'blank' && enabledAgents.includes(defaultAgent)) {
    return defaultAgent
  }
  return AGENT_CATALOG.find((entry) => enabledAgents.includes(entry.id))?.id ?? null
}

type CheckDetailsLoadState = {
  loading: boolean
  details: PRCheckRunDetails | null
  error: string | null
}

function getCheckDetailsKey(check: PRCheckDetail): string {
  return String(check.checkRunId ?? check.workflowRunId ?? check.url ?? check.name)
}

function formatCheckTimestamp(input: string | null | undefined): string | null {
  if (!input) {
    return null
  }
  const date = new Date(input)
  if (Number.isNaN(date.getTime())) {
    return null
  }
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}

function ChecksTab({
  item,
  repoPath,
  repoId,
  headSha,
  checks,
  loading,
  variant = 'compact',
  onChecksUpdated
}: {
  item: GitHubWorkItem
  repoPath: string | null
  repoId: string | null
  headSha: string | undefined
  checks: GitHubWorkItemDetails['checks']
  loading: boolean
  variant?: 'compact' | 'page'
  onChecksUpdated: (checks: PRCheckDetail[]) => void
}): React.JSX.Element {
  const [localChecks, setLocalChecks] = useState<PRCheckDetail[] | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [rerunning, setRerunning] = useState(false)
  const [fixingChecks, setFixingChecks] = useState(false)
  const [expandedCheckKey, setExpandedCheckKey] = useState<string | null>(null)
  const [detailsByCheckKey, setDetailsByCheckKey] = useState<Record<string, CheckDetailsLoadState>>(
    {}
  )
  const list = useMemo(() => localChecks ?? checks ?? [], [checks, localChecks])
  const prRepo = useMemo(() => parseOwnerRepoFromItemUrl(item.url), [item.url])
  const sorted = [...list].sort(
    (a, b) =>
      (CHECK_SORT_ORDER[getCheckConclusion(a)] ?? 3) -
      (CHECK_SORT_ORDER[getCheckConclusion(b)] ?? 3)
  )
  const failedChecks = getBrokenChecks(list)
  const counts = getCheckCounts(list)
  const summaryLabel = getChecksSummaryLabel(list)
  const SummaryIcon =
    counts.failing > 0
      ? CHECK_ICON.failure
      : counts.pending > 0
        ? CHECK_ICON.pending
        : list.length > 0
          ? CHECK_ICON.success
          : CircleDashed
  const summaryColor =
    counts.failing > 0
      ? CHECK_COLOR.failure
      : counts.pending > 0
        ? CHECK_COLOR.pending
        : list.length > 0
          ? CHECK_COLOR.success
          : 'text-muted-foreground'
  const canFixBrokenChecks = Boolean((repoId ?? item.repoId) && failedChecks.length > 0)

  useEffect(() => {
    setLocalChecks(null)
    setExpandedCheckKey(null)
    setDetailsByCheckKey({})
  }, [checks])

  const handleRefresh = useCallback(async (): Promise<PRCheckDetail[] | null> => {
    if (!repoPath) {
      toast.error('Unable to refresh checks without a repository path.')
      return null
    }
    setRefreshing(true)
    try {
      const nextChecks = (await window.api.gh.prChecks({
        repoPath,
        repoId: repoId ?? undefined,
        prNumber: item.number,
        headSha,
        noCache: true
      })) as PRCheckDetail[]
      setLocalChecks(nextChecks)
      onChecksUpdated(nextChecks)
      return nextChecks
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to refresh checks')
      return null
    } finally {
      setRefreshing(false)
    }
  }, [headSha, item.number, onChecksUpdated, repoId, repoPath])

  const handleRerun = useCallback(
    async (failedOnly: boolean): Promise<void> => {
      if (!repoPath || rerunning) {
        return
      }
      setRerunning(true)
      try {
        const result = await window.api.gh.rerunPRChecks({
          repoPath,
          repoId: repoId ?? undefined,
          prNumber: item.number,
          headSha,
          failedOnly
        })
        if (!result.ok) {
          toast.error(result.error)
          return
        }
        toast.success(result.count === 1 ? 'Check rerun requested' : 'Check reruns requested')
        await handleRefresh()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to rerun checks')
      } finally {
        setRerunning(false)
      }
    },
    [handleRefresh, headSha, item.number, rerunning, repoId, repoPath]
  )

  const handleFixBrokenChecks = useCallback(async (): Promise<void> => {
    const targetRepoId = repoId ?? item.repoId
    if (!targetRepoId || fixingChecks) {
      return
    }
    if (failedChecks.length === 0) {
      toast.message('No broken checks to fix.')
      return
    }

    setFixingChecks(true)
    try {
      const prompt = buildFixBrokenChecksPrompt(item, list)
      const store = useAppStore.getState()
      const attachedWorkspace = findGithubPrWorkspaceAttachment(
        store.allWorktrees(),
        targetRepoId,
        item.number
      )

      if (!attachedWorkspace) {
        await launchWorkItemDirect({
          item: { ...item, pasteContent: prompt },
          repoId: targetRepoId,
          launchSource: 'task_page',
          telemetrySource: 'sidebar',
          openModalFallback: () => {
            toast.error('Unable to create a fix workspace automatically.')
          }
        })
        return
      }

      if (!activateAndRevealWorktree(attachedWorkspace.id)) {
        toast.error('Unable to open the workspace attached to this pull request.')
        return
      }

      const connectionId = getConnectionId(attachedWorkspace.id)
      if (connectionId === undefined) {
        toast.error('Unable to resolve the workspace connection.')
        return
      }

      const activeStore = useAppStore.getState()
      const detectedAgents =
        typeof connectionId === 'string'
          ? await activeStore.ensureRemoteDetectedAgents(connectionId)
          : await activeStore.ensureDetectedAgents()
      const agent = pickDefaultAgent(
        activeStore.settings?.defaultTuiAgent,
        detectedAgents,
        activeStore.settings?.disabledTuiAgents
      )
      if (!agent) {
        toast.error('No enabled AI agents. Configure agents in Settings.')
        return
      }

      const result = launchAgentInNewTab({
        agent,
        worktreeId: attachedWorkspace.id,
        prompt,
        promptDelivery: 'draft',
        launchSource: 'task_page'
      })
      if (!result) {
        toast.error('Could not build the agent launch command.')
        return
      }
      focusTerminalTabSurface(result.tabId)
      toast.success('Started an AI agent for the broken checks.')
    } finally {
      setFixingChecks(false)
    }
  }, [failedChecks.length, fixingChecks, item, list, repoId])

  const handleToggleCheckDetails = useCallback(
    (check: PRCheckDetail): void => {
      const key = getCheckDetailsKey(check)
      setExpandedCheckKey((current) => (current === key ? null : key))
      if (
        !repoPath ||
        detailsByCheckKey[key] ||
        (!check.checkRunId && !check.workflowRunId && !check.url)
      ) {
        return
      }
      setDetailsByCheckKey((current) => ({
        ...current,
        [key]: { loading: true, details: null, error: null }
      }))
      void window.api.gh
        .prCheckDetails({
          repoPath,
          repoId: repoId ?? undefined,
          checkRunId: check.checkRunId,
          workflowRunId: check.workflowRunId,
          checkName: check.name,
          url: check.url,
          prRepo
        })
        .then((details) => {
          setDetailsByCheckKey((current) => ({
            ...current,
            [key]: {
              loading: false,
              details,
              error: details ? null : 'No inline details are available for this check.'
            }
          }))
        })
        .catch((err) => {
          setDetailsByCheckKey((current) => ({
            ...current,
            [key]: {
              loading: false,
              details: null,
              error: err instanceof Error ? err.message : 'Failed to load check details.'
            }
          }))
        })
    },
    [detailsByCheckKey, prRepo, repoId, repoPath]
  )

  const refreshAction = (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="size-7 shrink-0"
          disabled={!repoPath || refreshing}
          onClick={() => void handleRefresh()}
          aria-label="Refresh checks"
        >
          <RefreshCw className={cn('size-3.5', refreshing && 'animate-spin')} />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        Refresh checks
      </TooltipContent>
    </Tooltip>
  )
  const fixBrokenChecksAction =
    failedChecks.length > 0 || fixingChecks ? (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="xs"
            className="h-7 gap-1 px-2 text-[11px]"
            disabled={!canFixBrokenChecks || fixingChecks}
            onClick={() => void handleFixBrokenChecks()}
          >
            {fixingChecks ? (
              <LoaderCircle className="size-3 animate-spin" />
            ) : (
              <Wrench className="size-3" />
            )}
            {variant === 'compact' ? 'Fix checks' : 'Fix broken checks'}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          Start the default AI agent on these checks
        </TooltipContent>
      </Tooltip>
    ) : null
  const rerunAction =
    list.length > 0 || rerunning ? (
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="xs"
            className="h-7 gap-1 px-2 text-[11px]"
            disabled={!repoPath || rerunning || list.length === 0}
          >
            {rerunning ? (
              <LoaderCircle className="size-3 animate-spin" />
            ) : (
              <RefreshCw className="size-3" />
            )}
            Rerun
            <ChevronDown className="size-3 opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuItem
            disabled={failedChecks.length === 0 || rerunning}
            onSelect={() => void handleRerun(true)}
          >
            <RefreshCw className="size-4" />
            Rerun failed checks
          </DropdownMenuItem>
          <DropdownMenuItem disabled={rerunning} onSelect={() => void handleRerun(false)}>
            <RefreshCw className="size-4" />
            Rerun all checks
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    ) : null
  const secondaryActions =
    variant === 'compact' && !fixBrokenChecksAction ? null : fixBrokenChecksAction ||
      rerunAction ? (
      <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
        {fixBrokenChecksAction}
        {variant === 'page' ? rerunAction : null}
      </div>
    ) : null
  const actions = (
    <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
      {refreshAction}
      {fixBrokenChecksAction}
      {rerunAction}
    </div>
  )
  const compactHeader = (
    <div className="border-b border-border/50 px-3 py-2">
      <div className="flex min-w-0 items-start gap-2">
        <div className="flex min-w-0 flex-1 items-start gap-2">
          <SummaryIcon
            className={cn(
              'mt-0.5 size-3.5 shrink-0',
              summaryColor,
              counts.pending > 0 && counts.failing === 0 && 'animate-spin'
            )}
          />
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium leading-5 text-foreground">Checks</div>
            {list.length > 0 && (
              <div className="truncate text-[11px] leading-4 text-muted-foreground">
                {summaryLabel}
              </div>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {refreshAction}
          {list.length > 0 && (
            <div className="[&_button]:h-7 [&_button]:px-2 [&_button]:text-[11px]">
              {rerunAction}
            </div>
          )}
        </div>
      </div>
      {secondaryActions ? (
        <div className="mt-2 flex min-w-0 justify-end">{secondaryActions}</div>
      ) : null}
    </div>
  )

  const renderCheckRow = (check: PRCheckDetail): React.JSX.Element => {
    const conclusion = getCheckConclusion(check)
    const Icon = CHECK_ICON[conclusion] ?? CircleDashed
    const color = CHECK_COLOR[conclusion] ?? 'text-muted-foreground'
    const statusLabel = getCheckStatusLabel(check)
    const key = getCheckDetailsKey(check)
    const expanded = expandedCheckKey === key
    const detailsState = detailsByCheckKey[key]
    return (
      <div key={key} className="min-w-0">
        <button
          type="button"
          onClick={() => handleToggleCheckDetails(check)}
          aria-expanded={expanded}
          className={cn(
            'flex w-full min-w-0 items-center gap-2 rounded-md text-left transition',
            variant === 'page' ? 'px-3 py-2.5 hover:bg-accent/60' : 'px-2 py-1.5 hover:bg-muted/40'
          )}
        >
          <ChevronDown
            className={cn(
              'size-3 shrink-0 text-muted-foreground transition-transform',
              !expanded && '-rotate-90'
            )}
          />
          <Icon
            className={cn('size-3.5 shrink-0', color, conclusion === 'pending' && 'animate-spin')}
          />
          <span className="min-w-0 flex-1 truncate text-[12px] text-foreground">{check.name}</span>
          <span className="shrink-0 text-[11px] text-muted-foreground">{statusLabel}</span>
        </button>
        {expanded && renderCheckDetails(check, detailsState)}
      </div>
    )
  }

  const renderCheckDetails = (
    check: PRCheckDetail,
    state: CheckDetailsLoadState | undefined
  ): React.JSX.Element => {
    const details = state?.details
    const openUrl = details?.detailsUrl ?? details?.url ?? check.url
    const startedAt = formatCheckTimestamp(details?.startedAt)
    const completedAt = formatCheckTimestamp(details?.completedAt)
    const detailsStatusCheck: PRCheckDetail = {
      ...check,
      status: (details?.status as PRCheckDetail['status'] | undefined) ?? check.status,
      conclusion:
        (details?.conclusion as PRCheckDetail['conclusion'] | undefined) ?? check.conclusion
    }
    const hasOutput = Boolean(details?.title || details?.summary || details?.text)
    const hasAnnotations = (details?.annotations.length ?? 0) > 0
    const hasJobs = (details?.jobs.length ?? 0) > 0

    return (
      <div className="mx-2 mb-2 mt-1 min-w-0 rounded-md border border-border/50 bg-muted/20 px-3 py-2">
        {state?.loading ? (
          <div className="flex items-center gap-2 py-2 text-[12px] text-muted-foreground">
            <LoaderCircle className="size-3.5 animate-spin" />
            Loading check details…
          </div>
        ) : (
          <div className="flex min-w-0 flex-col gap-2">
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
              <span>
                Status:{' '}
                {details ? getCheckStatusLabel(detailsStatusCheck) : getCheckStatusLabel(check)}
              </span>
              {startedAt && <span>Started {startedAt}</span>}
              {completedAt && <span>Completed {completedAt}</span>}
              {check.checkRunId && <span className="font-mono">check #{check.checkRunId}</span>}
            </div>

            {state?.error && <div className="text-[12px] text-muted-foreground">{state.error}</div>}

            {hasOutput && (
              <div className="min-w-0 rounded-md border border-border/40 bg-background/70 px-2.5 py-2">
                {details?.title && (
                  <div className="mb-1 text-[12px] font-medium text-foreground">
                    {details.title}
                  </div>
                )}
                {details?.summary && (
                  <CommentMarkdown
                    content={details.summary}
                    variant="document"
                    className="min-w-0 max-w-full overflow-hidden break-words text-[12px] leading-relaxed [&_a]:break-all [&_code]:break-words [&_pre]:max-w-full"
                  />
                )}
                {details?.text && (
                  <CommentMarkdown
                    content={details.text}
                    variant="document"
                    className="mt-2 min-w-0 max-w-full overflow-hidden break-words text-[12px] leading-relaxed [&_a]:break-all [&_code]:break-words [&_pre]:max-w-full"
                  />
                )}
              </div>
            )}

            {hasAnnotations && (
              <div className="min-w-0 rounded-md border border-border/40 bg-background/70">
                <div className="border-b border-border/40 px-2.5 py-1.5 text-[11px] font-medium text-foreground">
                  Annotations
                </div>
                <div className="flex max-h-48 flex-col overflow-y-auto scrollbar-sleek">
                  {details!.annotations.map((annotation, index) => (
                    <div
                      key={`${annotation.path ?? 'annotation'}-${index}`}
                      className={cn(
                        'min-w-0 px-2.5 py-2 text-[12px]',
                        index > 0 && 'border-t border-border/30'
                      )}
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
                          {annotation.path ?? 'Annotation'}
                          {annotation.startLine ? `:${annotation.startLine}` : ''}
                        </span>
                        {annotation.annotationLevel && (
                          <span className="shrink-0 text-[11px] text-muted-foreground">
                            {annotation.annotationLevel}
                          </span>
                        )}
                      </div>
                      {annotation.title && (
                        <div className="mt-1 text-[12px] font-medium text-foreground">
                          {annotation.title}
                        </div>
                      )}
                      <div className="mt-1 break-words text-[12px] text-foreground">
                        {annotation.message}
                      </div>
                      {annotation.rawDetails && (
                        <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-2 font-mono text-[11px] text-muted-foreground scrollbar-sleek">
                          {annotation.rawDetails}
                        </pre>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {hasJobs && (
              <div className="min-w-0 rounded-md border border-border/40 bg-background/70">
                <div className="border-b border-border/40 px-2.5 py-1.5 text-[11px] font-medium text-foreground">
                  Jobs
                </div>
                <div className="flex max-h-64 flex-col overflow-y-auto scrollbar-sleek">
                  {details!.jobs.map((job, index) => (
                    <div
                      key={`${job.name}-${index}`}
                      className={cn(
                        'min-w-0 px-2.5 py-2',
                        index > 0 && 'border-t border-border/30'
                      )}
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground">
                          {job.name}
                        </span>
                        <span className="shrink-0 text-[11px] text-muted-foreground">
                          {job.conclusion ?? job.status ?? 'unknown'}
                        </span>
                      </div>
                      {job.steps.length > 0 && (
                        <div className="mt-1 grid gap-1">
                          {job.steps.map((step) => (
                            <div
                              key={step.name}
                              className="flex min-w-0 items-center gap-2 text-[11px] text-muted-foreground"
                            >
                              <span className="min-w-0 flex-1 truncate">{step.name}</span>
                              <span className="shrink-0">{step.conclusion ?? step.status}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {!state?.error && !hasOutput && !hasAnnotations && !hasJobs && (
              <div className="text-[12px] text-muted-foreground">
                No inline output is available for this check.
              </div>
            )}

            {openUrl && (
              <div>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className="h-7 gap-1 px-2 text-[11px]"
                  onClick={() => window.api.shell.openUrl(openUrl)}
                >
                  Open in GitHub
                  <ExternalLink className="size-3" />
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    )
  }

  if (loading && list.length === 0) {
    return (
      <>
        {variant === 'compact' ? compactHeader : null}
        <div className="flex items-center justify-center py-10">
          <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
        </div>
      </>
    )
  }
  if (list.length === 0) {
    if (variant === 'page') {
      return (
        <div className="flex flex-col gap-3 px-4 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <CircleDashed className="size-4 shrink-0 text-muted-foreground" />
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[13px] font-medium text-foreground">
                No checks found
              </span>
              <span className="truncate text-[11px] text-muted-foreground">
                This pull request has no reported checks yet.
              </span>
            </div>
            {actions}
          </div>
        </div>
      )
    }
    return (
      <>
        {compactHeader}
        <div className="flex flex-col items-center justify-center gap-1 px-4 py-6 text-center">
          <CircleDashed className="size-4 text-muted-foreground/60" />
          <div className="text-[12px] text-muted-foreground">No checks reported yet</div>
        </div>
      </>
    )
  }
  if (variant === 'page') {
    const countChips: { label: string; className: string }[] = []
    if (counts.passing > 0) {
      countChips.push({ label: `${counts.passing} passing`, className: CHECK_COLOR.success })
    }
    if (counts.failing > 0) {
      countChips.push({ label: `${counts.failing} failing`, className: CHECK_COLOR.failure })
    }
    if (counts.pending > 0) {
      countChips.push({ label: `${counts.pending} pending`, className: CHECK_COLOR.pending })
    }
    if (counts.skipped + counts.neutral > 0) {
      countChips.push({
        label: `${counts.skipped + counts.neutral} skipped`,
        className: 'text-muted-foreground'
      })
    }
    return (
      <div className="flex flex-col gap-3 px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <SummaryIcon
            className={cn(
              'size-4 shrink-0',
              summaryColor,
              counts.pending > 0 && counts.failing === 0 && 'animate-spin'
            )}
          />
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <span className="truncate text-[13px] font-medium text-foreground">{summaryLabel}</span>
            {countChips.length > 1 && (
              <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                {countChips.map((chip, i) => (
                  <React.Fragment key={chip.label}>
                    {i > 0 && <span className="opacity-40">·</span>}
                    <span className={chip.className}>{chip.label}</span>
                  </React.Fragment>
                ))}
              </span>
            )}
          </div>
          {actions}
        </div>
        <div className="overflow-hidden rounded-lg border border-border/50 bg-card shadow-xs">
          {sorted.map((check, index) => (
            <div
              key={getCheckDetailsKey(check)}
              className={cn(index > 0 && 'border-t border-border/40')}
            >
              {renderCheckRow(check)}
            </div>
          ))}
        </div>
      </div>
    )
  }
  return (
    <>
      {compactHeader}
      <div className="max-h-[280px] overflow-y-auto p-1 scrollbar-sleek">
        {sorted.map(renderCheckRow)}
      </div>
    </>
  )
}

function MentionTextarea({
  value,
  onValueChange,
  onKeyDown,
  placeholder,
  rows,
  className,
  wrapperClassName,
  mentionOptions,
  textareaRef
}: {
  value: string
  onValueChange: (value: string) => void
  onKeyDown?: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void
  placeholder: string
  rows: number
  className?: string
  wrapperClassName?: string
  mentionOptions: MentionOption[]
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
}): React.JSX.Element {
  const [mentionQuery, setMentionQuery] = useState<MentionQuery | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  const suggestions = useMemo(
    () => (mentionQuery ? filterMentionOptions(mentionOptions, mentionQuery.query) : []),
    [mentionOptions, mentionQuery]
  )
  const showSuggestions = mentionQuery !== null && suggestions.length > 0

  const syncMentionQuery = useCallback((textarea: HTMLTextAreaElement): void => {
    const nextQuery = findMentionQuery(textarea.value, textarea.selectionStart)
    setMentionQuery(nextQuery)
    setActiveIndex(0)
  }, [])

  const insertMention = useCallback(
    (option: MentionOption): void => {
      const textarea = textareaRef.current
      const caret = textarea?.selectionStart ?? value.length
      const query = textarea ? findMentionQuery(value, caret) : mentionQuery
      if (!query) {
        return
      }
      const suffix = value[caret] && !/\s/.test(value[caret]) ? ' ' : ''
      const inserted = `@${option.login}${suffix}`
      const nextValue = `${value.slice(0, query.atIndex)}${inserted}${value.slice(caret)}`
      const nextCaret = query.atIndex + inserted.length
      onValueChange(nextValue)
      setMentionQuery(null)
      requestAnimationFrame(() => {
        textarea?.focus()
        textarea?.setSelectionRange(nextCaret, nextCaret)
      })
    },
    [mentionQuery, onValueChange, textareaRef, value]
  )

  return (
    <div className={cn('relative min-w-0 flex-1', wrapperClassName)}>
      {showSuggestions && (
        <div className="absolute right-0 bottom-[calc(100%+6px)] left-0 z-50 max-h-64 overflow-y-auto rounded-md border border-border/70 bg-popover p-1 text-popover-foreground shadow-lg scrollbar-sleek">
          {suggestions.map((option, index) => (
            <button
              key={option.login}
              type="button"
              onMouseDown={(event) => {
                event.preventDefault()
                insertMention(option)
              }}
              className={cn(
                'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[12px]',
                index === activeIndex && 'bg-accent text-accent-foreground'
              )}
            >
              {option.avatarUrl ? (
                <img src={option.avatarUrl} alt="" className="size-5 shrink-0 rounded-full" />
              ) : (
                <div className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground">
                  {option.login.slice(0, 1).toUpperCase()}
                </div>
              )}
              <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
                <span className="shrink-0 font-medium">@{option.login}</span>
                {option.name && (
                  <>
                    <span className="shrink-0 text-muted-foreground">|</span>
                    <span className="truncate text-muted-foreground">{option.name}</span>
                  </>
                )}
                <span className="shrink-0 text-muted-foreground">|</span>
                <span className="shrink-0 text-[11px] text-muted-foreground">{option.source}</span>
              </span>
            </button>
          ))}
        </div>
      )}
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(event) => {
          onValueChange(event.target.value)
          syncMentionQuery(event.currentTarget)
        }}
        onClick={(event) => syncMentionQuery(event.currentTarget)}
        onKeyUp={(event) => {
          if (!['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(event.key)) {
            syncMentionQuery(event.currentTarget)
          }
        }}
        onBlur={() => setMentionQuery(null)}
        onKeyDown={(event) => {
          if (showSuggestions) {
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              setActiveIndex((current) => (current + 1) % suggestions.length)
              return
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault()
              setActiveIndex((current) => (current - 1 + suggestions.length) % suggestions.length)
              return
            }
            if (event.key === 'Enter' || event.key === 'Tab') {
              event.preventDefault()
              insertMention(suggestions[activeIndex] ?? suggestions[0])
              return
            }
            if (event.key === 'Escape') {
              event.preventDefault()
              setMentionQuery(null)
              return
            }
          }
          onKeyDown?.(event)
        }}
        placeholder={placeholder}
        rows={rows}
        className={className}
      />
    </div>
  )
}

// Why: when the dialog opens for a Project row whose repo differs from the
// active workspace, mutations must target the row's actual repo via
// slug-addressed IPCs. Otherwise edits silently apply to the workspace's
// repo. The edit IPCs return a structured `{ ok, error }` shape; we adapt
// to a thrown rejection so the existing `useImmediateMutation` flow
// (which expects throws on failure) continues to work unchanged.
async function runIssueUpdate(args: {
  repoPath: string | null
  repoId?: string | null
  projectOrigin: PullRequestPageProjectOrigin | undefined
  number: number
  updates: Parameters<typeof window.api.gh.updateIssue>[0]['updates']
}): Promise<void> {
  if (args.projectOrigin) {
    const target = getActiveRuntimeTarget(useAppStore.getState().settings)
    const updateArgs = {
      owner: args.projectOrigin.owner,
      repo: args.projectOrigin.repo,
      number: args.number,
      updates: args.updates
    }
    const res =
      target.kind === 'environment'
        ? await callRuntimeRpc<Awaited<ReturnType<typeof window.api.gh.updateIssueBySlug>>>(
            target,
            'github.project.updateIssueBySlug',
            updateArgs,
            { timeoutMs: 30_000 }
          )
        : await window.api.gh.updateIssueBySlug(updateArgs)
    if (!res.ok) {
      throw new Error(res.error.message)
    }
    return
  }
  if (!args.repoPath) {
    throw new Error('No repo context available for this edit.')
  }
  const res = await window.api.gh.updateIssue({
    repoPath: args.repoPath,
    repoId: args.repoId ?? undefined,
    number: args.number,
    updates: args.updates
  })
  if (!res.ok) {
    throw new Error(res.error)
  }
}

async function runWorkItemBodyUpdate(args: {
  item: GitHubWorkItem
  repoPath: string | null
  projectOrigin: PullRequestPageProjectOrigin | undefined
  body: string
  parsedSlug: GitHubOwnerRepo | null
}): Promise<void> {
  if (args.item.type === 'pr') {
    const targetSlug = args.projectOrigin
      ? { owner: args.projectOrigin.owner, repo: args.projectOrigin.repo }
      : args.parsedSlug
    if (!targetSlug) {
      throw new Error('No GitHub repository context available for this pull request.')
    }
    const target = getActiveRuntimeTarget(useAppStore.getState().settings)
    const updateArgs = {
      owner: targetSlug.owner,
      repo: targetSlug.repo,
      number: args.item.number,
      updates: { body: args.body }
    }
    const res =
      target.kind === 'environment'
        ? await callRuntimeRpc<Awaited<ReturnType<typeof window.api.gh.updatePullRequestBySlug>>>(
            target,
            'github.project.updatePullRequestBySlug',
            updateArgs,
            { timeoutMs: 30_000 }
          )
        : await window.api.gh.updatePullRequestBySlug(updateArgs)
    if (!res.ok) {
      throw new Error(res.error.message)
    }
    return
  }

  await runIssueUpdate({
    repoPath: args.repoPath,
    repoId: args.item.repoId,
    projectOrigin: args.projectOrigin,
    number: args.item.number,
    updates: { body: args.body }
  })
}

async function runPullRequestStateUpdate(args: {
  repoPath: string | null
  repoId?: string | null
  projectOrigin: PullRequestPageProjectOrigin | undefined
  number: number
  updates: { state: 'open' | 'closed' }
}): Promise<void> {
  if (args.projectOrigin) {
    const target = getActiveRuntimeTarget(useAppStore.getState().settings)
    const updateArgs = {
      owner: args.projectOrigin.owner,
      repo: args.projectOrigin.repo,
      number: args.number,
      updates: args.updates
    }
    const res =
      target.kind === 'environment'
        ? await callRuntimeRpc<Awaited<ReturnType<typeof window.api.gh.updatePullRequestBySlug>>>(
            target,
            'github.project.updatePullRequestBySlug',
            updateArgs,
            { timeoutMs: 30_000 }
          )
        : await window.api.gh.updatePullRequestBySlug(updateArgs)
    if (!res.ok) {
      throw new Error(res.error.message)
    }
    return
  }
  if (!args.repoPath) {
    throw new Error('No repo context available for this pull request.')
  }
  const res = await window.api.gh.updatePRState({
    repoPath: args.repoPath,
    repoId: args.repoId ?? undefined,
    prNumber: args.number,
    updates: args.updates
  })
  if (!res.ok) {
    throw new Error(res.error)
  }
}

function GHEditSection({
  item,
  repoPath,
  repoId,
  projectOrigin,
  localState,
  localLabels,
  onStateChange,
  onLabelsChange,
  onMutated,
  assignees,
  onUse
}: {
  item: GitHubWorkItem
  repoPath: string | null
  repoId: string | null
  projectOrigin: PullRequestPageProjectOrigin | undefined
  localState: GitHubWorkItem['state']
  localLabels: string[]
  onStateChange: (state: GitHubWorkItem['state']) => void
  onLabelsChange: (labels: string[]) => void
  /** Why: called after a successful issue mutation so the parent dialog can
   *  invalidate its work-item-details cache entry. Without this, reopening the
   *  drawer in the FRESH_MS window would paint pre-mutation data. */
  onMutated: () => void
  assignees: string[]
  onUse: (item: GitHubWorkItem) => void
}): React.JSX.Element | null {
  const [labelPopoverOpen, setLabelPopoverOpen] = useState(false)
  const [assigneePopoverOpen, setAssigneePopoverOpen] = useState(false)
  const [localAssignees, setLocalAssignees] = useState<string[]>(assignees)
  const hasEditedAssigneesRef = useRef(false)
  const patchWorkItem = useAppStore((s) => s.patchWorkItem)
  const patchProjectRowContent = useAppStore((s) => s.patchProjectRowContent)
  const { isPending, run } = useImmediateMutation()
  // Why: when the dialog opens from a Project view, mutations route through
  // *BySlug IPCs and we must keep `projectViewCache` in sync alongside
  // `workItemsCache` — `patchWorkItem` only walks the latter, so without this
  // helper the Project table would render stale data until manual refresh.
  // See docs/design/github-project-view-tasks.md §Dialog editing from Project rows.
  const patchProjectRowIfNeeded = useCallback(
    (patch: Parameters<typeof patchProjectRowContent>[2]) => {
      if (!projectOrigin) {
        return
      }
      patchProjectRowContent(projectOrigin.cacheKey, projectOrigin.projectItemId, patch)
    },
    [projectOrigin, patchProjectRowContent]
  )

  // Why: when projectOrigin is set we MUST read labels/assignees from the
  // row's repo, not from the workspace path — otherwise the popovers list
  // values from a different repo than the writes target.
  const slugOwner = projectOrigin?.owner ?? null
  const slugRepo = projectOrigin?.repo ?? null
  const repoLabelsByPath = useRepoLabels(
    projectOrigin ? null : repoPath,
    projectOrigin ? null : repoId
  )
  const repoLabelsBySlug = useRepoLabelsBySlug(slugOwner, slugRepo)
  const repoLabels = projectOrigin ? repoLabelsBySlug : repoLabelsByPath
  const repoAssigneesByPath = useRepoAssignees(
    projectOrigin ? null : repoPath,
    projectOrigin ? null : repoId
  )
  const repoAssigneesBySlug = useRepoAssigneesBySlug(slugOwner, slugRepo, assignees)
  const repoAssignees = projectOrigin ? repoAssigneesBySlug : repoAssigneesByPath

  // Why: sync local assignees when item changes or when the detail fetch
  // resolves with real data — but skip if the user already made an
  // optimistic edit so we don't clobber in-flight changes.
  useEffect(() => {
    if (hasEditedAssigneesRef.current) {
      return
    }
    setLocalAssignees(assignees)
  }, [item.id, assignees])

  // Reset the dirty flag when we switch to a different item.
  useEffect(() => {
    hasEditedAssigneesRef.current = false
  }, [item.id])

  const handleStateChange = useCallback(
    (newState: 'open' | 'closed') => {
      if (newState === localState) {
        return
      }
      const prevState = localState
      run('state', {
        mutate: () =>
          runIssueUpdate({
            repoId: item.repoId,
            repoPath,
            projectOrigin,
            number: item.number,
            updates: { state: newState }
          }),
        onOptimistic: () => {
          onStateChange(newState)
          patchWorkItem(item.id, { state: newState }, item.repoId)
          patchProjectRowIfNeeded({ state: newState })
        },
        onRevert: () => {
          onStateChange(prevState)
          patchWorkItem(item.id, { state: prevState }, item.repoId)
          patchProjectRowIfNeeded({ state: prevState })
        },
        onSuccess: () => {
          patchWorkItem(item.id, { state: newState }, item.repoId)
          patchProjectRowIfNeeded({ state: newState })
          onMutated()
        },
        onError: (err) => toast.error(err)
      })
    },
    [
      item.id,
      item.number,
      item.repoId,
      localState,
      repoPath,
      projectOrigin,
      patchWorkItem,
      patchProjectRowIfNeeded,
      run,
      onStateChange,
      onMutated
    ]
  )

  const handleLabelToggle = useCallback(
    (label: string) => {
      const isAdding = !localLabels.includes(label)
      const prevLabels = localLabels
      const newLabels = isAdding ? [...prevLabels, label] : prevLabels.filter((l) => l !== label)

      if (isAdding) {
        run('labels', {
          mutate: () =>
            runIssueUpdate({
              repoId: item.repoId,
              repoPath,
              projectOrigin,
              number: item.number,
              updates: { addLabels: [label] }
            }),
          onOptimistic: () => {
            onLabelsChange(newLabels)
            patchWorkItem(item.id, { labels: newLabels }, item.repoId)
            patchProjectRowIfNeeded({ labels: newLabels })
          },
          onSuccess: () => {
            onMutated()
          },
          onRevert: () => {
            onLabelsChange(prevLabels)
            patchWorkItem(item.id, { labels: prevLabels }, item.repoId)
            patchProjectRowIfNeeded({ labels: prevLabels })
          },
          onError: (err) => toast.error(err)
        })
      } else {
        run('labels', {
          mutate: () =>
            runIssueUpdate({
              repoId: item.repoId,
              repoPath,
              projectOrigin,
              number: item.number,
              updates: { removeLabels: [label] }
            }),
          onOptimistic: () => {
            onLabelsChange(newLabels)
            patchWorkItem(item.id, { labels: newLabels }, item.repoId)
            patchProjectRowIfNeeded({ labels: newLabels })
          },
          onRevert: () => {
            onLabelsChange(prevLabels)
            patchWorkItem(item.id, { labels: prevLabels }, item.repoId)
            patchProjectRowIfNeeded({ labels: prevLabels })
          },
          onSuccess: () => {
            onMutated()
          },
          onError: (err) => toast.error(err)
        })
      }
    },
    [
      item.id,
      item.number,
      item.repoId,
      localLabels,
      repoPath,
      projectOrigin,
      patchWorkItem,
      patchProjectRowIfNeeded,
      run,
      onLabelsChange,
      onMutated
    ]
  )

  const handleAssigneeToggle = useCallback(
    (login: string) => {
      const isAssigned = localAssignees.includes(login)
      const prevAssignees = localAssignees
      const newAssignees = isAssigned
        ? prevAssignees.filter((l) => l !== login)
        : [...prevAssignees, login]

      hasEditedAssigneesRef.current = true
      if (isAssigned) {
        run('assignees', {
          mutate: () =>
            runIssueUpdate({
              repoId: item.repoId,
              repoPath,
              projectOrigin,
              number: item.number,
              updates: { removeAssignees: [login] }
            }),
          onOptimistic: () => {
            setLocalAssignees(newAssignees)
            patchProjectRowIfNeeded({ assignees: newAssignees })
          },
          onRevert: () => {
            setLocalAssignees(prevAssignees)
            patchProjectRowIfNeeded({ assignees: prevAssignees })
          },
          onSuccess: () => {
            onMutated()
          },
          onError: (err) => toast.error(err)
        })
      } else {
        run('assignees', {
          mutate: () =>
            runIssueUpdate({
              repoId: item.repoId,
              repoPath,
              projectOrigin,
              number: item.number,
              updates: { addAssignees: [login] }
            }),
          onOptimistic: () => {
            setLocalAssignees(newAssignees)
            patchProjectRowIfNeeded({ assignees: newAssignees })
          },
          onSuccess: () => {
            onMutated()
          },
          onRevert: () => {
            setLocalAssignees(prevAssignees)
            patchProjectRowIfNeeded({ assignees: prevAssignees })
          },
          onError: (err) => toast.error(err)
        })
      }
    },
    [
      item.number,
      item.repoId,
      repoPath,
      projectOrigin,
      localAssignees,
      patchProjectRowIfNeeded,
      run,
      onMutated
    ]
  )

  if (item.type === 'pr') {
    return null
  }

  const checkIcon = (
    <svg className="size-2.5" viewBox="0 0 12 12" fill="none">
      <path
        d="M2 6l3 3 5-5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border/60 px-4 py-2.5">
      {/* State */}
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={cn(
              'group/status inline-flex items-center gap-0.5 rounded-full border px-2 py-0.5 text-[11px] font-medium transition hover:brightness-125 hover:ring-1 hover:ring-white/10',
              getStateTone({ ...item, state: localState })
            )}
          >
            {getStateLabel({ ...item, state: localState })}
            <ChevronDown className="size-2.5 opacity-50" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-36 p-1" align="start">
          <button
            type="button"
            onClick={() => handleStateChange('open')}
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
            onClick={() => handleStateChange('closed')}
            className={cn(
              'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-[12px] hover:bg-accent',
              localState === 'closed' && 'bg-accent/50'
            )}
          >
            <CircleDashed className="size-3 text-rose-500" />
            Closed
          </button>
        </PopoverContent>
      </Popover>

      {/* Labels */}
      <Popover open={labelPopoverOpen} onOpenChange={setLabelPopoverOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={isPending('labels') || repoLabels.loading}
            className="group/labels inline-flex items-center gap-1 rounded-full border border-border/30 bg-muted/20 px-2 py-0.5 text-[11px] transition hover:brightness-125 hover:ring-1 hover:ring-white/10 disabled:opacity-50"
          >
            {localLabels.length === 0 ? (
              <span className="text-muted-foreground">+ Label</span>
            ) : (
              localLabels.map((name) => (
                <span key={name} className="text-[10px] text-muted-foreground">
                  {name}
                </span>
              ))
            )}
            {isPending('labels') ? (
              <LoaderCircle className="size-3 animate-spin text-muted-foreground" />
            ) : (
              <ChevronDown className="size-2.5 opacity-50" />
            )}
          </button>
        </PopoverTrigger>
        <PopoverContent className="popover-scroll-content scrollbar-sleek w-52 p-1" align="start">
          {repoLabels.error ? (
            <div className="px-2 py-3 text-center text-[12px] text-destructive">
              {repoLabels.error}
            </div>
          ) : (
            <div>
              {repoLabels.data.map((label) => (
                <button
                  key={label}
                  type="button"
                  onClick={() => handleLabelToggle(label)}
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-[12px] hover:bg-accent"
                >
                  <span
                    className={cn(
                      'flex size-3.5 items-center justify-center rounded-sm border',
                      localLabels.includes(label)
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-input'
                    )}
                  >
                    {localLabels.includes(label) && checkIcon}
                  </span>
                  {label}
                </button>
              ))}
            </div>
          )}
        </PopoverContent>
      </Popover>

      {/* Assignees */}
      <Popover open={assigneePopoverOpen} onOpenChange={setAssigneePopoverOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={isPending('assignees') || repoAssignees.loading}
            className="group/assignees inline-flex items-center gap-1 rounded-full border border-border/30 bg-muted/20 px-2 py-0.5 text-[11px] transition hover:brightness-125 hover:ring-1 hover:ring-white/10 disabled:opacity-50"
          >
            {localAssignees.length === 0 ? (
              <span className="text-muted-foreground">+ Assignee</span>
            ) : (
              localAssignees.map((login) => (
                <span key={login} className="text-[10px] text-muted-foreground">
                  {login}
                </span>
              ))
            )}
            {isPending('assignees') ? (
              <LoaderCircle className="size-3 animate-spin text-muted-foreground" />
            ) : (
              <ChevronDown className="size-2.5 opacity-50" />
            )}
          </button>
        </PopoverTrigger>
        <PopoverContent className="popover-scroll-content scrollbar-sleek w-52 p-1" align="start">
          {repoAssignees.error ? (
            <div className="px-2 py-3 text-center text-[12px] text-destructive">
              {repoAssignees.error}
            </div>
          ) : (
            <div>
              {repoAssignees.data.map((user) => (
                <button
                  key={user.login}
                  type="button"
                  onClick={() => handleAssigneeToggle(user.login)}
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-[12px] hover:bg-accent"
                >
                  <span
                    className={cn(
                      'flex size-3.5 items-center justify-center rounded-sm border',
                      localAssignees.includes(user.login)
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-input'
                    )}
                  >
                    {localAssignees.includes(user.login) && checkIcon}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{user.login}</span>
                    {user.name && (
                      <span className="block truncate text-[11px] text-muted-foreground">
                        {user.name}
                      </span>
                    )}
                  </span>
                </button>
              ))}
            </div>
          )}
        </PopoverContent>
      </Popover>

      <Button
        size="sm"
        onClick={() => onUse(item)}
        className="ml-auto gap-2"
        aria-label="Start workspace from issue"
      >
        Start workspace from issue
        <ArrowRight className="size-4" />
      </Button>
    </div>
  )
}

function GHCommentComposer({
  className,
  repoPath,
  repoId,
  issueNumber,
  itemType,
  mentionOptions,
  onCommentAdded
}: {
  className?: string
  repoPath: string
  repoId?: string | null
  issueNumber: number
  itemType: 'issue' | 'pr'
  mentionOptions: MentionOption[]
  onCommentAdded: (comment: PRComment) => void
}): React.JSX.Element {
  const [body, setBody] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const autoGrow = useCallback(() => {
    const el = textareaRef.current
    if (!el) {
      return
    }
    el.style.height = 'auto'
    el.style.height = `${Math.max(80, Math.min(el.scrollHeight, 240))}px`
  }, [])

  const handleSubmit = useCallback(async () => {
    const trimmed = body.trim()
    if (!trimmed) {
      return
    }
    setSubmitting(true)
    try {
      const result = await addIssueCommentForRepo({
        repoPath,
        repoId: repoId ?? undefined,
        number: issueNumber,
        body: trimmed,
        type: itemType
      })
      if (result.ok) {
        setBody('')
        requestAnimationFrame(autoGrow)
        // Why: use the comment returned by GitHub so the optimistic row shows
        // the real login/avatar immediately instead of waiting for a reopen.
        onCommentAdded(result.comment)
      } else {
        toast.error(result.error ?? 'Failed to add comment')
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to add comment')
    } finally {
      setSubmitting(false)
    }
  }, [autoGrow, body, repoPath, repoId, issueNumber, itemType, onCommentAdded])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        handleSubmit()
      }
    },
    [handleSubmit]
  )

  return (
    <div className={cn('flex flex-col items-start gap-2', className)}>
      <MentionTextarea
        textareaRef={textareaRef}
        value={body}
        onValueChange={(nextValue) => {
          setBody(nextValue)
          requestAnimationFrame(autoGrow)
        }}
        onKeyDown={handleKeyDown}
        placeholder="Add a comment…"
        rows={4}
        mentionOptions={mentionOptions}
        wrapperClassName="flex min-h-20 w-full items-stretch"
        className="scrollbar-sleek block h-20 max-h-[240px] min-h-20 w-full resize-none overflow-y-auto rounded-md border border-input bg-card px-3 py-2 text-[13px] leading-5 placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
      <Button
        onClick={handleSubmit}
        disabled={!body.trim() || submitting}
        className="gap-2"
        aria-label="Send comment"
      >
        {submitting ? (
          <LoaderCircle className="size-3.5 animate-spin" />
        ) : (
          <Send className="size-3.5" />
        )}
        Comment
      </Button>
    </div>
  )
}

// Why: the issue-source indicator is issue-only and lives on GitHubItemDialog;
// PullRequestPage doesn't render it.

export default function PullRequestPage({
  workItem,
  repoPath,
  repoId,
  initialTab,
  backLabel = 'Pull requests',
  projectOrigin,
  onUse,
  onReviewRequestsChange,
  onClose
}: PullRequestPageProps): React.JSX.Element {
  // Why: this component is page-only — the sheet variant lives in GitHubItemDialog.
  const [tab, setTab] = useState<ItemDialogTab>(() => normalizeItemDialogTab(workItem, initialTab))
  const [localState, setLocalState] = useState<GitHubWorkItem['state']>(workItem?.state ?? 'open')
  const [localLabels, setLocalLabels] = useState<string[]>(workItem?.labels ?? [])
  const [linkCopied, setLinkCopied] = useState(false)
  const workItemId = workItem?.id
  const workItemState = workItem?.state
  const workItemLabels = workItem?.labels
  const workItemType = workItem?.type
  const effectiveRepoId = repoId ?? workItem?.repoId ?? null
  const allWorktrees = useAllWorktrees()
  const attachedWorkspace = useMemo(
    () =>
      workItem?.type === 'pr'
        ? findGithubPrWorkspaceAttachment(allWorktrees, effectiveRepoId, workItem.number)
        : null,
    [allWorktrees, effectiveRepoId, workItem]
  )
  const attachedWorkspaceLabel = attachedWorkspace
    ? getGithubPrWorkspaceAttachmentLabel(attachedWorkspace)
    : null

  // Why: the cache key has to include the issue source preference so a user
  // toggling between origin/upstream for the same issue number doesn't read
  // back the wrong repo's details. We pull it from the repos slice rather
  // than threading it as a prop because every existing call site already has
  // the repo registered in the store.
  const issueSourcePreference = useAppStore((s) => {
    if (!repoPath && !effectiveRepoId) {
      return undefined
    }
    return s.repos.find((r) => (effectiveRepoId ? r.id === effectiveRepoId : r.path === repoPath))
      ?.issueSourcePreference
  })
  const detailsCacheKey = useMemo(() => {
    if (!workItem || !repoPath || !effectiveRepoId) {
      return null
    }
    return getWorkItemDetailsCacheKey({
      repoPath,
      repoId: effectiveRepoId,
      issueSourcePreference,
      type: workItem.type,
      number: workItem.number
    })
  }, [repoPath, effectiveRepoId, workItem, issueSourcePreference])

  // Why: reset lifted edit state when the dialog switches items or when the
  // same item receives an optimistic cache patch from the surrounding table.
  useEffect(() => {
    if (workItemState && workItemLabels) {
      setLocalState(workItemState)
      setLocalLabels(workItemLabels)
    }
  }, [workItemId, workItemState, workItemLabels])

  useEffect(() => {
    const nextTab = workItemType === 'pr' ? (initialTab ?? 'conversation') : 'conversation'
    setTab(nextTab)
  }, [workItemId, workItemType, initialTab])

  const handleUseWorkItem = useCallback((): void => {
    if (!workItem) {
      return
    }
    const targetRepoId = effectiveRepoId
    onUse(
      targetRepoId && targetRepoId !== workItem.repoId
        ? { ...workItem, repoId: targetRepoId }
        : workItem
    )
  }, [effectiveRepoId, onUse, workItem])

  const handleOpenOrUsePR = useCallback((): void => {
    if (!workItem) {
      return
    }
    const targetRepoId = effectiveRepoId
    const currentAttached = findGithubPrWorkspaceAttachment(
      useAppStore.getState().allWorktrees(),
      targetRepoId,
      workItem.number
    )
    if (!currentAttached) {
      handleUseWorkItem()
      return
    }

    const result = activateAndRevealWorktree(currentAttached.id)
    if (result === false) {
      toast.error('Unable to open the workspace attached to this pull request.')
    }
  }, [effectiveRepoId, handleUseWorkItem, workItem])

  // Why: track comments added optimistically before the detail fetch resolves
  // so they can be merged into the fetch result instead of being overwritten.
  const optimisticCommentsRef = useRef<PRComment[]>([])
  // Why: track the last item we fetched so we can distinguish "reopen same
  // item" from "switch to a different item". Reopening the same item must
  // preserve optimistic comments because gh's 60s response cache will return
  // stale data that doesn't include the just-posted comment.
  const prevItemIdRef = useRef<string | null>(null)

  // Why: when this dialog opens immediately after another Radix overlay
  // (e.g. the New Issue dialog) closed, Radix may leave `pointer-events: none`
  // on <body>. That silently kills clicks on the header's Close/open-in-GitHub
  // buttons. Poll a few frames to clear it whenever Radix re-applies it during
  // its own mount sequence.
  useEffect(() => {
    if (!workItem) {
      return
    }
    let cancelled = false
    let count = 0
    let frameId: number | null = null
    const tick = (): void => {
      frameId = null
      if (cancelled) {
        return
      }
      if (document.body.style.pointerEvents === 'none') {
        document.body.style.pointerEvents = ''
      }
      if (count++ < 5) {
        frameId = requestAnimationFrame(tick)
      }
    }
    tick()
    return () => {
      cancelled = true
      if (frameId !== null) {
        cancelAnimationFrame(frameId)
      }
    }
  }, [workItem])

  // Why: subscribe to the module-level cache so reopening a cached item
  // paints synchronously on first render. getSnapshot returns the entry
  // object directly — touchWorkItemDetailsCache writes always replace entry
  // identity (delete+set), so Map.get is referentially stable between writes.
  const cachedEntry = useSyncExternalStore(
    subscribeWorkItemDetailsCache,
    useCallback(
      () => (detailsCacheKey ? workItemDetailsCache.get(detailsCacheKey) : undefined),
      [detailsCacheKey]
    )
  )

  // Why: bumped by appendOptimisticComment on cold open (no cached details
  // yet) so the details memo re-runs and surfaces the optimistic comment via
  // the loading-shell fallback. Without this, the comment would sit in the
  // ref alone and not render until the in-flight fetch lands. The cache
  // notify path handles the warm case.
  const [optimisticTick, setOptimisticTick] = useState(0)

  // Why: merge optimistic comments into the cached details. Keyed off
  // cachedEntry identity (stable) rather than the optimistic ref array (a
  // fresh array each render) to avoid unnecessary recomputation. Cache
  // notifications after optimistic writes will re-render this anyway.
  const details = useMemo<GitHubWorkItemDetails | null>(() => {
    const cachedDetails = cachedEntry?.details ?? null
    const opt = optimisticCommentsRef.current
    if (!cachedDetails) {
      // Why: details may still be loading on a cold open — surface optimistic
      // comments via a minimal shell so a comment posted before the fetch
      // resolves isn't held invisibly in ref-land.
      if (opt.length > 0 && workItem) {
        return { item: workItem, body: '', comments: [...opt] }
      }
      return null
    }
    if (opt.length === 0) {
      return cachedDetails
    }
    const ids = new Set(cachedDetails.comments.map((c) => c.id))
    const missing = opt.filter((c) => !ids.has(c.id))
    if (missing.length === 0) {
      return cachedDetails
    }
    return { ...cachedDetails, comments: [...cachedDetails.comments, ...missing] }
    // Why: optimisticTick is the rerender signal for cold-open writes — the
    // memo reads optimisticCommentsRef.current (a ref, no subscription), so
    // bumping the tick is what forces this memo to re-run. The lint flags it
    // as "unnecessary" because it's not referenced in the body, but removing
    // it would silently break the cold-open optimistic-shell path.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cachedEntry, workItem, optimisticTick])

  const loading = !!cachedEntry?.pending && !cachedEntry?.details
  const error = cachedEntry?.error && !cachedEntry?.details ? cachedEntry.error : null
  const detailsLoaded =
    Boolean(cachedEntry?.details) ||
    Boolean(cachedEntry && !cachedEntry.pending && !cachedEntry.error && cachedEntry.fetchedAt > 0)

  // Why: if a cross-window mutation invalidates the open drawer's entry
  // (cachedEntry becomes undefined while workItem is still set), the main
  // fetch effect won't re-run because its deps haven't changed. Bump a local
  // tick so the fetch effect fires a refetch in that case.
  const [refetchTick, setRefetchTick] = useState(0)
  useEffect(() => {
    if (workItem && detailsCacheKey && !cachedEntry) {
      setRefetchTick((n) => n + 1)
    }
  }, [workItem, detailsCacheKey, cachedEntry])

  useEffect(() => {
    if (!workItem || !repoPath || !detailsCacheKey) {
      return
    }
    // Why: only clear optimistic comments when switching to a genuinely
    // different item. When reopening the same item (close → reopen), the
    // gh API's 60s response cache will return stale data that omits the
    // just-posted comment — preserving the optimistic ref lets the merge
    // logic above re-attach it to the stale response.
    if (workItem.id !== prevItemIdRef.current) {
      optimisticCommentsRef.current = []
    }
    prevItemIdRef.current = workItem.id

    const cached = workItemDetailsCache.get(detailsCacheKey)
    const now = Date.now()
    const hasFreshData = cached?.details && now - cached.fetchedAt <= WORK_ITEM_DETAILS_FRESH_MS

    if (hasFreshData) {
      return
    }

    // Why: dedupe concurrent opens for the same key — concurrent dialogs or
    // a rapid close→reopen must share one in-flight promise instead of
    // racing two `gh` subprocesses against each other.
    const inflight: Promise<GitHubWorkItemDetails | null> =
      cached?.pending ??
      getWorkItemDetailsForRepo({
        repoPath,
        repoId: effectiveRepoId ?? undefined,
        number: workItem.number,
        type: workItem.type
      })

    // Why: snapshot the invalidation generation at fetch start; if the
    // generation advances before we resolve, a mutation invalidated the
    // entry mid-flight and we must not write a stale result back.
    const launchedAtGeneration = workItemDetailsCacheGeneration

    if (!cached?.pending) {
      touchWorkItemDetailsCache(detailsCacheKey, {
        details: cached?.details ?? null,
        fetchedAt: cached?.fetchedAt ?? 0,
        pending: inflight,
        error: cached?.error
      })
    }

    inflight
      .then((result) => {
        const invalidatedMidFlight = workItemDetailsCacheGeneration !== launchedAtGeneration
        const prev = workItemDetailsCache.get(detailsCacheKey)
        if (invalidatedMidFlight) {
          // Why: entry was deliberately dropped; do not recreate it. If the
          // entry still exists (later open repopulated it) leave it alone too.
          return
        }
        // Why: 404/unauthorized must not overwrite valid cached data. When the
        // IPC resolves to null and we already have cached details, keep the
        // stale data — only blank entries get the null payload.
        if (result === null && prev?.details) {
          touchWorkItemDetailsCache(detailsCacheKey, {
            details: prev.details,
            fetchedAt: prev.fetchedAt,
            error: undefined
          })
        } else {
          touchWorkItemDetailsCache(detailsCacheKey, {
            details: result,
            fetchedAt: Date.now(),
            error: undefined
          })
        }
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : 'Failed to load details'
        const invalidatedMidFlight = workItemDetailsCacheGeneration !== launchedAtGeneration
        if (invalidatedMidFlight) {
          return
        }
        const prev = workItemDetailsCache.get(detailsCacheKey)
        // Why: stale-on-error — keep cached data if we have it, drop the
        // pending promise so the next open can retry. Only surface the
        // blocking error when nothing is cached.
        touchWorkItemDetailsCache(detailsCacheKey, {
          details: prev?.details ?? null,
          fetchedAt: prev?.fetchedAt ?? 0,
          error: message
        })
      })
  }, [repoPath, effectiveRepoId, workItem, detailsCacheKey, refetchTick])

  const Icon = workItem?.type === 'pr' ? GitPullRequest : CircleDot
  const displayWorkItem = useMemo<GitHubWorkItem | null>(() => {
    if (!workItem) {
      return null
    }
    if (!details?.item) {
      return workItem
    }
    return { ...workItem, ...details.item, repoId: workItem.repoId }
  }, [details?.item, workItem])

  useEffect(() => {
    if (!workItem || details?.item.reviewRequests === undefined) {
      return
    }
    // Why: PR details can carry fresher reviewer metadata than the list row;
    // push it back so the Tasks review chip doesn't keep a stale snapshot.
    onReviewRequestsChange?.(
      { id: workItem.id, repoId: workItem.repoId },
      details.item.reviewRequests
    )
  }, [details?.item.reviewRequests, onReviewRequestsChange, workItem])

  const body = details?.body ?? ''
  const comments = details?.comments ?? []
  const files = details?.files ?? []
  const checks = details?.checks ?? []
  const [pendingViewedPaths, setPendingViewedPaths] = useState<Set<string>>(() => new Set())
  // Why: clipboard IPC can resolve after the page unmounts; skip copied-state
  // feedback instead of starting its reset timer on a stale surface.
  const linkCopyMountedRef = useRef(false)
  const setLinkCopyButtonRef = useCallback((node: HTMLButtonElement | null) => {
    linkCopyMountedRef.current = node !== null
  }, [])

  useEffect(() => {
    setLinkCopied(false)
  }, [workItemId])

  useEffect(() => {
    if (!linkCopied) {
      return
    }
    const handle = window.setTimeout(() => setLinkCopied(false), 1500)
    return () => window.clearTimeout(handle)
  }, [linkCopied])

  const handleCopyWorkItemLink = useCallback(async (): Promise<void> => {
    if (!workItem) {
      return
    }
    try {
      // Why: Electron's clipboard IPC is reliable even when browser clipboard
      // APIs lose focus/activation inside nested overlay surfaces.
      await window.api.ui.writeClipboardText(workItem.url)
      if (!linkCopyMountedRef.current) {
        return
      }
      setLinkCopied(true)
      toast.success('GitHub link copied')
    } catch {
      toast.error('Failed to copy GitHub link')
    }
  }, [workItem])

  const appendOptimisticComment = useCallback(
    (comment: PRComment) => {
      // Why: skip refreshDetails() — gh api --cache 60s returns stale data
      // that overwrites the optimistic comment. The next dialog open (after
      // cache expiry) will pick up the server-confirmed version.
      optimisticCommentsRef.current.push(comment)
      // Why: write through the module-level cache so subscribers (this
      // drawer plus any concurrent ones on the same item) re-render with the
      // optimistic comment. Mark fetchedAt as stale (0) so the next open
      // still triggers a background refresh to pick up server-side fields
      // like reaction groups or thread bindings.
      if (detailsCacheKey) {
        const prev = workItemDetailsCache.get(detailsCacheKey)
        if (prev?.details) {
          const ids = new Set(prev.details.comments.map((c) => c.id))
          if (!ids.has(comment.id)) {
            touchWorkItemDetailsCache(detailsCacheKey, {
              details: { ...prev.details, comments: [...prev.details.comments, comment] },
              fetchedAt: 0,
              error: undefined
            })
            return
          }
        }
      }
      // Why: when the cache has no details yet (still loading), no cache
      // write/notify fires above. Bump local state so the details memo
      // re-runs and surfaces the optimistic comment via the loading-shell
      // fallback instead of holding it invisibly in the ref.
      setOptimisticTick((n) => n + 1)
    },
    [detailsCacheKey]
  )

  const handlePRFileViewedChange = useCallback(
    async (path: string, viewed: boolean): Promise<boolean> => {
      if (!repoPath || !details?.pullRequestId || !workItem || workItem.type !== 'pr') {
        toast.error('Unable to sync viewed state for this pull request.')
        return false
      }
      setPendingViewedPaths((prev) => new Set(prev).add(path))
      const nextState: GitHubPRFileViewedState = viewed ? 'VIEWED' : 'UNVIEWED'
      const previousState = detailsCacheKey
        ? patchCachedPRFileViewedState(detailsCacheKey, path, nextState)
        : undefined
      try {
        const ok = await setPRFileViewedForRepo({
          repoId: workItem.repoId,
          repoPath,
          prNumber: workItem.number,
          pullRequestId: details.pullRequestId,
          path,
          viewed
        })
        if (!ok) {
          if (detailsCacheKey && previousState) {
            patchCachedPRFileViewedState(detailsCacheKey, path, previousState)
          }
          toast.error('Failed to sync viewed state with GitHub.')
          return false
        }
        return true
      } finally {
        setPendingViewedPaths((prev) => {
          const next = new Set(prev)
          next.delete(path)
          return next
        })
      }
    },
    [details?.pullRequestId, detailsCacheKey, repoPath, workItem]
  )

  const ownerRepo = parseOwnerRepoFromItemUrl(workItem?.url ?? '')
  const headBranch = workItem?.branchName
  const baseBranch = workItem?.baseRefName
  const stateBadgeTone =
    localState === 'merged'
      ? 'bg-purple-600 text-white'
      : localState === 'draft'
        ? 'bg-slate-500 text-white'
        : localState === 'closed'
          ? 'bg-rose-600 text-white'
          : 'bg-emerald-600 text-white'
  const stateBadgeLabel = workItem ? getStateLabel({ ...workItem, state: localState }) : 'Open'

  const content = workItem ? (
    <div className="flex h-full min-h-0 flex-col">
      {/* Row 1: page header strip — breadcrumb-style row mirroring Primer canvas-subtle */}
      <div className="flex-none border-b border-border/60 bg-muted/30 px-6 py-2.5">
        <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onClose}
            className="-ml-2 h-7 gap-1 px-2 text-muted-foreground hover:text-foreground"
            aria-label={backLabel}
          >
            <ChevronLeft className="size-4" />
            {backLabel}
          </Button>
          <span className="text-border">·</span>
          {ownerRepo ? (
            <>
              <span className="truncate">
                <span className="text-muted-foreground">{ownerRepo.owner}</span>
                <span className="mx-1 text-muted-foreground/60">/</span>
                <span className="font-medium text-foreground">{ownerRepo.repo}</span>
              </span>
              <span className="text-muted-foreground/60">·</span>
            </>
          ) : null}
          <span className="font-mono text-muted-foreground">#{workItem.number}</span>
          <div className="ml-auto flex items-center gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  ref={setLinkCopyButtonRef}
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => void handleCopyWorkItemLink()}
                  aria-label="Copy GitHub link"
                >
                  {linkCopied ? (
                    <Check className="size-4 text-emerald-500" />
                  ) : (
                    <Copy className="size-4" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={6}>
                {linkCopied ? 'Copied' : 'Copy GitHub link'}
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => window.api.shell.openUrl(workItem.url)}
                  aria-label="Open on GitHub"
                >
                  <ExternalLink className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={6}>
                Open on GitHub
              </TooltipContent>
            </Tooltip>
          </div>
        </div>
      </div>

      {/* Row 2: PR title block — large weight-400 title + state row, mirrors Primer pr-title-block */}
      <div className="flex-none border-b border-border/60 px-6 py-4">
        <div className="flex items-start gap-4">
          <h1 className="min-w-0 flex-1 text-[28px] font-medium leading-tight text-foreground">
            <span className="break-words">{workItem.title}</span>
            <span className="ml-2 font-light text-muted-foreground">#{workItem.number}</span>
          </h1>
          <div className="flex shrink-0 items-center gap-2">
            {/* Why: Orca's signature affordance — keep this primary so it stands out
                against GitHub's familiar surface. */}
            <DropdownMenu modal={false}>
              <ButtonGroup>
                <Button
                  type="button"
                  size="sm"
                  onClick={handleOpenOrUsePR}
                  className="gap-1.5 whitespace-nowrap"
                  aria-label={
                    attachedWorkspace ? 'Open workspace attached to PR' : 'Start workspace from PR'
                  }
                >
                  {attachedWorkspace ? 'Open workspace' : 'Start workspace from PR'}
                  <ArrowRight className="size-3.5" />
                </Button>
                <DropdownMenuTrigger asChild>
                  <Button type="button" size="icon-sm" aria-label="More PR workspace actions">
                    <ChevronDown className="size-3.5" />
                  </Button>
                </DropdownMenuTrigger>
              </ButtonGroup>
              <DropdownMenuContent align="end">
                {attachedWorkspace ? (
                  <DropdownMenuItem onSelect={handleUseWorkItem}>
                    <Plus className="size-4" />
                    Start new workspace
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuItem onSelect={() => window.api.shell.openUrl(workItem.url)}>
                  <ExternalLink className="size-4" />
                  Open on GitHub
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
          <span
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[12px] font-medium',
              stateBadgeTone
            )}
          >
            <Icon className="size-3.5" />
            {stateBadgeLabel}
          </span>
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="font-semibold text-foreground">{workItem.author ?? 'unknown'}</span>
            <span>wants to merge into</span>
            {baseBranch ? (
              <span className="rounded-md bg-accent/40 px-1.5 py-0.5 font-mono text-[12px] text-accent-foreground">
                {baseBranch}
              </span>
            ) : (
              <span className="italic">base branch</span>
            )}
            <span>from</span>
            {headBranch ? (
              <span className="rounded-md bg-accent/40 px-1.5 py-0.5 font-mono text-[12px] text-accent-foreground">
                {headBranch}
              </span>
            ) : (
              <span className="italic">head branch</span>
            )}
            <span className="text-muted-foreground/80">
              · updated {formatRelativeTime(workItem.updatedAt)}
            </span>
          </span>
          {attachedWorkspaceLabel ? (
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <FolderKanban className="size-3.5 shrink-0" />
              <span className="truncate">{attachedWorkspaceLabel}</span>
            </span>
          ) : null}
        </div>
      </div>

      {(repoPath || projectOrigin) && (
        <GHEditSection
          item={workItem}
          repoPath={repoPath}
          repoId={effectiveRepoId}
          projectOrigin={projectOrigin}
          localState={localState}
          localLabels={localLabels}
          onStateChange={setLocalState}
          onLabelsChange={setLocalLabels}
          onMutated={() => {
            // Why: drop the cached details for this item so the next
            // open issues a fresh fetch instead of painting pre-edit
            // state. We invalidate by (repoPath, type, number) match
            // because a single mutation can affect entries across all
            // issueSourcePreference values for the same number.
            if (repoPath) {
              invalidateWorkItemDetailsCacheByMatch({
                repoPath,
                repoId: effectiveRepoId ?? undefined,
                type: workItem.type,
                number: workItem.number
              })
            }
          }}
          assignees={details?.assignees ?? []}
          onUse={onUse}
        />
      )}

      <div className="min-h-0 flex-1">
        {error ? (
          <div className="px-4 py-6 text-[12px] text-destructive">{error}</div>
        ) : (
          <Tabs
            value={tab}
            onValueChange={(value) => setTab(value as ItemDialogTab)}
            className="flex h-full min-h-0 flex-col gap-0"
          >
            {/* Why: page-level tabs sit on a flat strip; the line variant
                already paints an underline under the active tab via its own
                ::after, so don't add a second border that boxes the trigger. */}
            <TabsList
              variant="line"
              className="mx-0 justify-start gap-2 border-b border-border/60 bg-transparent px-6"
            >
              <TabsTrigger value="conversation" className="px-3 py-2.5">
                <MessageSquare className="size-3.5" />
                Conversation
              </TabsTrigger>
              <TabsTrigger value="checks" className="px-3 py-2.5">
                <ListChecks className="size-3.5" />
                Checks
                {checks.length > 0 && (
                  <span className="ml-1 rounded-full bg-muted px-1.5 text-[10px] text-muted-foreground">
                    {checks.length}
                  </span>
                )}
              </TabsTrigger>
              <TabsTrigger value="files" className="px-3 py-2.5">
                <FileText className="size-3.5" />
                Files changed
                {files.length > 0 && (
                  <span className="ml-1 rounded-full bg-muted px-1.5 text-[10px] text-muted-foreground">
                    {files.length}
                  </span>
                )}
              </TabsTrigger>
            </TabsList>

            <div className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek">
              <TabsContent value="conversation" className="mt-0">
                <ConversationTab
                  item={displayWorkItem ?? workItem}
                  repoPath={repoPath}
                  repoId={effectiveRepoId}
                  body={body}
                  comments={comments}
                  files={files}
                  headSha={details?.headSha}
                  baseSha={details?.baseSha}
                  loading={loading}
                  detailsLoaded={detailsLoaded}
                  checks={checks}
                  participants={details?.participants ?? []}
                  localState={localState}
                  onStateChange={setLocalState}
                  projectOrigin={projectOrigin}
                  onMutated={() => {
                    if (repoPath) {
                      invalidateWorkItemDetailsCacheByMatch({
                        repoPath,
                        repoId: effectiveRepoId ?? undefined,
                        type: workItem.type,
                        number: workItem.number
                      })
                    }
                  }}
                  onChecksUpdated={(nextChecks) => {
                    if (detailsCacheKey) {
                      patchCachedPRChecks(detailsCacheKey, nextChecks)
                    }
                  }}
                  onBodyUpdated={(nextBody) => {
                    if (detailsCacheKey) {
                      patchCachedWorkItemBody(detailsCacheKey, nextBody)
                    }
                  }}
                  onCommentAdded={appendOptimisticComment}
                  onReviewersRequested={(nextReviewRequests) => {
                    if (detailsCacheKey) {
                      patchCachedPRReviewRequests(detailsCacheKey, nextReviewRequests)
                    }
                    onReviewRequestsChange?.(
                      { id: workItem.id, repoId: workItem.repoId },
                      nextReviewRequests
                    )
                  }}
                />
              </TabsContent>

              <TabsContent value="checks" className="mt-0">
                <ChecksTab
                  item={workItem}
                  repoPath={repoPath}
                  repoId={effectiveRepoId}
                  headSha={details?.headSha}
                  checks={checks}
                  loading={loading || !detailsLoaded}
                  variant="page"
                  onChecksUpdated={(nextChecks) => {
                    if (detailsCacheKey) {
                      patchCachedPRChecks(detailsCacheKey, nextChecks)
                    }
                  }}
                />
              </TabsContent>

              <TabsContent value="files" className="mt-0">
                {loading && files.length === 0 ? (
                  <div className="flex items-center justify-center py-10">
                    <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
                  </div>
                ) : files.length === 0 ? (
                  <div className="px-4 py-10 text-center text-[12px] text-muted-foreground">
                    No files changed.
                  </div>
                ) : (
                  <PRFilesCombinedDiffViewer
                    files={files}
                    comments={comments}
                    repoPath={repoPath ?? ''}
                    repoId={effectiveRepoId ?? ''}
                    prNumber={workItem.number}
                    prUrl={workItem.url}
                    headSha={details?.headSha}
                    baseSha={details?.baseSha}
                    pendingViewedPaths={pendingViewedPaths}
                    onCommentAdded={appendOptimisticComment}
                    onViewedChange={handlePRFileViewedChange}
                  />
                )}
              </TabsContent>
            </div>
          </Tabs>
        )}
      </div>
    </div>
  ) : null

  return <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">{content}</div>
}
