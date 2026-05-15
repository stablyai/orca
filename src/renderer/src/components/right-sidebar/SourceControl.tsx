/* eslint-disable max-lines */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDownUp,
  ArrowUp,
  ChevronDown,
  CloudUpload,
  Minus,
  Plus,
  RefreshCw,
  Settings2,
  Sparkles,
  Square,
  Undo2,
  FileEdit,
  FileMinus,
  FilePlus,
  FileQuestion,
  ArrowRightLeft,
  Check,
  Copy,
  FolderOpen,
  GitMerge,
  GitPullRequestArrow,
  MessageSquare,
  Send,
  Trash,
  TriangleAlert,
  CircleCheck,
  Search,
  X
} from 'lucide-react'
import { useAppStore } from '@/store'
import { useActiveWorktree, useRepoById, useWorktreeMap } from '@/store/selectors'
import { getHostedReviewCacheKey } from '@/store/slices/hosted-review'
import { detectLanguage } from '@/lib/language-detect'
import { basename, dirname, joinPath } from '@/lib/path'
import { cn } from '@/lib/utils'
import { isFolderRepo } from '../../../../shared/repo-kind'
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import {
  resolvePrimaryAction,
  type PrimaryAction,
  type RemoteOpKind
} from './source-control-primary-action'
import {
  resolveDropdownItems,
  type DropdownActionKind,
  type DropdownEntry
} from './source-control-dropdown-items'
import { BulkActionBar } from './BulkActionBar'
import { useSourceControlSelection, type FlatEntry } from './useSourceControlSelection'
import {
  getDiscardAllPaths,
  getStageAllPaths,
  getUnstageAllPaths,
  runDiscardAllForArea,
  type DiscardAllArea
} from './discard-all-sequence'
import {
  getDiscardAreaConfirmationCopy,
  getDiscardEntryConfirmationCopy,
  type DiscardConfirmationCopy
} from './source-control-discard-confirmation'
import { refreshGitStatusForWorktree } from './git-status-refresh'
import { toast } from 'sonner'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { BaseRefPicker } from '@/components/settings/BaseRefPicker'
import { formatDiffComment, formatDiffComments } from '@/lib/diff-comments-format'
import { QuickLaunchAgentMenuItems } from '@/components/tab-bar/QuickLaunchButton'
import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import {
  notifyEditorExternalFileChange,
  requestEditorSaveQuiesce
} from '@/components/editor/editor-autosave'
import { getConnectionId } from '@/lib/connection-context'
import {
  bulkStageRuntimeGitPaths,
  bulkUnstageRuntimeGitPaths,
  commitRuntimeGit,
  discardRuntimeGitPath,
  getRuntimeGitBranchCompare,
  stageRuntimeGitPath,
  unstageRuntimeGitPath
} from '@/runtime/runtime-git-client'
import { getRuntimeRepoBaseRefDefault } from '@/runtime/runtime-repo-client'
import { PullRequestIcon } from './checks-panel-content'
import type {
  DiffComment,
  GitBranchChangeEntry,
  GitBranchCompareSummary,
  GitConflictKind,
  GitConflictOperation,
  GitStatusEntry,
  GitUpstreamStatus
} from '../../../../shared/types'
import type { HostedReviewInfo } from '../../../../shared/hosted-review'
import { STATUS_COLORS, STATUS_LABELS } from './status-display'

type SourceControlScope = 'all' | 'uncommitted'

const STATUS_ICONS: Record<
  string,
  React.ComponentType<{ className?: string; style?: React.CSSProperties }>
> = {
  modified: FileEdit,
  added: FilePlus,
  deleted: FileMinus,
  renamed: ArrowRightLeft,
  untracked: FileQuestion,
  copied: FilePlus
}

// Why: directional signifiers ahead of each primary action label. Commit
// (✓) is affirmative; Push (↑) points in the direction data flows; Sync
// (↕) is bidirectional; Publish gets a cloud-up to distinguish the
// first-time publish from a subsequent push. Pull is intentionally
// icon-less — the down-arrow read as a download/save affordance and was
// removed. Keeping the mapping outside the render function avoids
// reallocating it on every render.
const PRIMARY_ICONS: Partial<
  Record<
    PrimaryAction['kind'],
    React.ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' | 'false' }>
  >
> = {
  commit: Check,
  stage: Plus,
  push: ArrowUp,
  sync: ArrowDownUp,
  publish: CloudUpload
}

// Why: unstaged ("Changes") is listed first so that conflict files — which
// are assigned area:'unstaged' by the parser — appear above "Staged Changes".
// This keeps unresolved conflicts visible at the top of the list where the
// user won't miss them.
const SECTION_ORDER = ['unstaged', 'staged', 'untracked'] as const
const SECTION_LABELS: Record<(typeof SECTION_ORDER)[number], string> = {
  staged: 'Staged Changes',
  unstaged: 'Changes',
  untracked: 'Untracked Files'
}

const BRANCH_REFRESH_INTERVAL_MS = 5000

// Why: the pure state-machine logic now lives in
// ./source-control-primary-action.ts. It is imported directly by callers
// (tests and other components) instead of going through this module.

type CommitDraftsByWorktree = Record<string, string>

type PendingDiscardConfirmation =
  | { kind: 'entry'; entry: GitStatusEntry }
  | { kind: 'area'; area: DiscardAllArea; paths: readonly string[] }

export function readCommitDraftForWorktree(
  drafts: CommitDraftsByWorktree,
  worktreeId: string | null | undefined
): string {
  return drafts[worktreeId ?? ''] ?? ''
}

export function writeCommitDraftForWorktree(
  drafts: CommitDraftsByWorktree,
  worktreeId: string,
  value: string
): CommitDraftsByWorktree {
  return { ...drafts, [worktreeId]: value }
}

const CONFLICT_KIND_LABELS: Record<GitConflictKind, string> = {
  both_modified: 'Both modified',
  both_added: 'Both added',
  deleted_by_us: 'Deleted by us',
  deleted_by_them: 'Deleted by them',
  added_by_us: 'Added by us',
  added_by_them: 'Added by them',
  both_deleted: 'Both deleted'
}

function hostedReviewStateClass(review: HostedReviewInfo): string {
  if (review.state === 'merged') {
    return 'text-purple-500/80'
  }
  if (review.state === 'open') {
    return 'text-emerald-500/80'
  }
  if (review.state === 'closed') {
    return 'text-muted-foreground/60'
  }
  return 'text-muted-foreground/50'
}

function HostedReviewIcon({
  review,
  className
}: {
  review: HostedReviewInfo
  className?: string
}): React.JSX.Element {
  const Icon = review.provider === 'gitlab' ? GitMerge : PullRequestIcon
  return <Icon className={cn(className, hostedReviewStateClass(review))} />
}

function SourceControlInner(): React.JSX.Element {
  const sourceControlRef = useRef<HTMLDivElement>(null)
  // Why: React setState is async, so a rapid double-click on the Commit
  // button can both pass the isCommitting state guard before the disabled
  // state re-renders. A ref flipped synchronously at the start of
  // handleCommit gives us a true single-flight lock.
  const commitInFlightRef = useRef<Record<string, boolean>>({})
  const activeWorktree = useActiveWorktree()
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const activeGroupId = useAppStore((s) =>
    activeWorktreeId ? s.activeGroupIdByWorktree[activeWorktreeId] : undefined
  )
  const worktreeMap = useWorktreeMap()
  const rightSidebarTab = useAppStore((s) => s.rightSidebarTab)
  const activeRepo = useRepoById(activeWorktree?.repoId ?? null)
  const gitStatusByWorktree = useAppStore((s) => s.gitStatusByWorktree)
  const gitConflictOperationByWorktree = useAppStore((s) => s.gitConflictOperationByWorktree)
  const gitBranchChangesByWorktree = useAppStore((s) => s.gitBranchChangesByWorktree)
  const gitBranchCompareSummaryByWorktree = useAppStore((s) => s.gitBranchCompareSummaryByWorktree)
  const remoteStatusesByWorktree = useAppStore((s) => s.remoteStatusesByWorktree)
  const isRemoteOperationActive = useAppStore((s) => s.isRemoteOperationActive)
  const inFlightRemoteOpKind = useAppStore((s) => s.inFlightRemoteOpKind)
  const settings = useAppStore((s) => s.settings)
  const hostedReviewCache = useAppStore((s) => s.hostedReviewCache)
  const fetchHostedReviewForBranch = useAppStore((s) => s.fetchHostedReviewForBranch)
  const updateRepo = useAppStore((s) => s.updateRepo)
  const setGitStatus = useAppStore((s) => s.setGitStatus)
  const updateWorktreeGitIdentity = useAppStore((s) => s.updateWorktreeGitIdentity)
  const beginGitBranchCompareRequest = useAppStore((s) => s.beginGitBranchCompareRequest)
  const setGitBranchCompareResult = useAppStore((s) => s.setGitBranchCompareResult)
  const fetchUpstreamStatus = useAppStore((s) => s.fetchUpstreamStatus)
  const setUpstreamStatus = useAppStore((s) => s.setUpstreamStatus)
  const pushBranch = useAppStore((s) => s.pushBranch)
  const pullBranch = useAppStore((s) => s.pullBranch)
  const syncBranch = useAppStore((s) => s.syncBranch)
  const fetchBranch = useAppStore((s) => s.fetchBranch)
  const revealInExplorer = useAppStore((s) => s.revealInExplorer)
  const trackConflictPath = useAppStore((s) => s.trackConflictPath)
  const openDiff = useAppStore((s) => s.openDiff)
  const openFile = useAppStore((s) => s.openFile)
  const setEditorViewMode = useAppStore((s) => s.setEditorViewMode)
  const openConflictFile = useAppStore((s) => s.openConflictFile)
  const openConflictReview = useAppStore((s) => s.openConflictReview)
  const openBranchDiff = useAppStore((s) => s.openBranchDiff)
  const openAllDiffs = useAppStore((s) => s.openAllDiffs)
  const openBranchAllDiffs = useAppStore((s) => s.openBranchAllDiffs)
  const deleteDiffComment = useAppStore((s) => s.deleteDiffComment)
  const setScrollToDiffCommentId = useAppStore((s) => s.setScrollToDiffCommentId)
  // Why: pass activeWorktreeId directly (even when null/undefined) so the
  // slice's getDiffComments returns its stable EMPTY_COMMENTS sentinel. An
  // inline `[]` fallback would allocate a new array each store update, break
  // Zustand's Object.is equality, and cause this component plus the
  // diffCommentCountByPath memo to churn on every unrelated store change.
  const diffCommentsForActive = useAppStore((s) => s.getDiffComments(activeWorktreeId))
  const diffCommentCount = diffCommentsForActive.length
  // Why: per-file counts are fed into each UncommittedEntryRow so a comment
  // badge can appear next to the status letter. Compute once per render so
  // rows don't each re-filter the full list.
  const diffCommentCountByPath = useMemo(() => {
    const map = new Map<string, number>()
    for (const c of diffCommentsForActive) {
      map.set(c.filePath, (map.get(c.filePath) ?? 0) + 1)
    }
    return map
  }, [diffCommentsForActive])
  const diffCommentsPrompt = useMemo(
    () => formatDiffComments(diffCommentsForActive),
    [diffCommentsForActive]
  )
  const [diffCommentsExpanded, setDiffCommentsExpanded] = useState(false)
  const [diffCommentsCopied, setDiffCommentsCopied] = useState(false)

  const handleCopyDiffComments = useCallback(async (): Promise<void> => {
    if (diffCommentsForActive.length === 0) {
      return
    }
    try {
      await window.api.ui.writeClipboardText(diffCommentsPrompt)
      setDiffCommentsCopied(true)
    } catch {
      // Why: swallow — clipboard write can fail when the window isn't focused.
      // No dedicated error surface is warranted for a best-effort copy action.
    }
  }, [diffCommentsForActive, diffCommentsPrompt])

  // Why: auto-dismiss the "copied" indicator so the button returns to its
  // default icon after a brief confirmation window.
  useEffect(() => {
    if (!diffCommentsCopied) {
      return
    }
    const handle = window.setTimeout(() => setDiffCommentsCopied(false), 1500)
    return () => window.clearTimeout(handle)
  }, [diffCommentsCopied])

  const [scope, setScope] = useState<SourceControlScope>('all')
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set())
  const [baseRefDialogOpen, setBaseRefDialogOpen] = useState(false)
  const [pendingDiscard, setPendingDiscard] = useState<PendingDiscardConfirmation | null>(null)
  // Why: start null rather than 'origin/main' so branch compare doesn't fire
  // with a fabricated ref before the IPC resolves. effectiveBaseRef stays
  // falsy until we have a real answer from the main process.
  const [defaultBaseRef, setDefaultBaseRef] = useState<string | null>(null)
  const [filterQuery, setFilterQuery] = useState('')
  // Why: commit drafts/errors are worktree-scoped during the mounted session,
  // so switching worktrees restores each draft instead of wiping it.
  const [commitDrafts, setCommitDrafts] = useState<CommitDraftsByWorktree>({})
  const [commitErrors, setCommitErrors] = useState<Record<string, string | null>>({})
  // Why: keep commit-in-flight state per-worktree. A single boolean would be
  // cleared when the user switched worktrees, letting them double-click Commit
  // on worktree A after briefly navigating to B and back while A's original
  // commit is still running.
  const [commitInFlightByWorktree, setCommitInFlightByWorktree] = useState<Record<string, boolean>>(
    {}
  )
  const isCommitting = commitInFlightByWorktree[activeWorktreeId ?? ''] ?? false
  // Why: parallel state to commit. Same per-worktree shape so navigating between
  // worktrees mid-generation never silently cancels the in-flight request.
  const generateInFlightRef = useRef<Record<string, boolean>>({})
  const [generateInFlightByWorktree, setGenerateInFlightByWorktree] = useState<
    Record<string, boolean>
  >({})
  const [generateErrors, setGenerateErrors] = useState<Record<string, string | null>>({})
  const isGenerating = generateInFlightByWorktree[activeWorktreeId ?? ''] ?? false
  const generateError = generateErrors[activeWorktreeId ?? ''] ?? null
  const commitMessageAi = useAppStore((s) => s.settings?.commitMessageAi)
  const filterInputRef = useRef<HTMLInputElement>(null)
  const commitMessage = readCommitDraftForWorktree(commitDrafts, activeWorktreeId)
  const commitError = commitErrors[activeWorktreeId ?? ''] ?? null

  const isFolder = activeRepo ? isFolderRepo(activeRepo) : false
  const worktreePath = activeWorktree?.path ?? null
  const entries = useMemo(
    () => (activeWorktreeId ? (gitStatusByWorktree[activeWorktreeId] ?? []) : []),
    [activeWorktreeId, gitStatusByWorktree]
  )
  const branchEntries = useMemo(
    () => (activeWorktreeId ? (gitBranchChangesByWorktree[activeWorktreeId] ?? []) : []),
    [activeWorktreeId, gitBranchChangesByWorktree]
  )
  const branchSummary = activeWorktreeId
    ? (gitBranchCompareSummaryByWorktree[activeWorktreeId] ?? null)
    : null
  const conflictOperation = activeWorktreeId
    ? (gitConflictOperationByWorktree[activeWorktreeId] ?? 'unknown')
    : 'unknown'
  // Why: leave undefined until fetchUpstreamStatus resolves for this worktree.
  // Substituting a synthetic { hasUpstream: false } flashes "Publish Branch"
  // on every worktree switch — resolvePrimaryAction treats it as an
  // unpublished branch until the real status lands a moment later.
  const remoteStatus: GitUpstreamStatus | undefined = activeWorktreeId
    ? remoteStatusesByWorktree[activeWorktreeId]
    : undefined
  const rightSidebarOpen = useAppStore((s) => s.rightSidebarOpen)
  // Why: gate polling on both the active tab AND the sidebar being open.
  // The sidebar now stays mounted when closed (for performance), so without
  // this guard the branchCompare interval and PR fetch would keep running
  // with no visible consumer, wasting git process spawns and API calls.
  const isBranchVisible = rightSidebarTab === 'source-control' && rightSidebarOpen

  const refreshActiveGitStatus = useCallback(async (): Promise<void> => {
    if (!activeWorktreeId || !worktreePath || isFolder) {
      return
    }
    const connectionId = getConnectionId(activeWorktreeId) ?? undefined
    await refreshGitStatusForWorktree({
      settings: useAppStore.getState().settings,
      worktreeId: activeWorktreeId,
      worktreePath,
      connectionId,
      deps: {
        setGitStatus,
        updateWorktreeGitIdentity,
        setUpstreamStatus,
        fetchUpstreamStatus
      }
    })
  }, [
    activeWorktreeId,
    fetchUpstreamStatus,
    isFolder,
    setGitStatus,
    setUpstreamStatus,
    updateWorktreeGitIdentity,
    worktreePath
  ])

  const refreshActiveGitStatusAfterMutation = useCallback(async (): Promise<void> => {
    try {
      await refreshActiveGitStatus()
    } catch (error) {
      console.warn('[SourceControl] post-mutation git status refresh failed', error)
    }
  }, [refreshActiveGitStatus])

  useEffect(() => {
    if (!activeRepo || isFolder) {
      return
    }

    // Why: reset to null so that effectiveBaseRef becomes falsy until the IPC
    // resolves.  This prevents the branch compare from firing with a stale
    // defaultBaseRef left over from a *different* repo (e.g. 'origin/master'
    // when the new repo uses 'origin/main'), which would cause a transient
    // "invalid-base" error every time the user switches between repos.
    setDefaultBaseRef(null)

    let stale = false
    void getRuntimeRepoBaseRefDefault(useAppStore.getState().settings, activeRepo.id)
      .then((result) => {
        if (!stale) {
          // Why: IPC now returns a `{ defaultBaseRef, remoteCount }` envelope;
          // this component only needs `defaultBaseRef`. `remoteCount` is used
          // by BaseRefPicker for the multi-remote hint.
          setDefaultBaseRef(result.defaultBaseRef)
        }
      })
      .catch((err) => {
        console.error('[SourceControl] getBaseRefDefault failed', err)
        // Why: leave defaultBaseRef null on failure instead of fabricating
        // 'origin/main'. effectiveBaseRef stays falsy, so branch compare and
        // PR fetch skip running against a ref that may not exist.
        if (!stale) {
          setDefaultBaseRef(null)
        }
      })

    return () => {
      stale = true
    }
  }, [activeRepo, isFolder])

  const effectiveBaseRef = activeRepo?.worktreeBaseRef ?? defaultBaseRef
  const hasUncommittedEntries = entries.length > 0

  const branchName = activeWorktree?.branch.replace(/^refs\/heads\//, '') ?? 'HEAD'
  const hostedReviewCacheKey =
    activeRepo && branchName ? getHostedReviewCacheKey(activeRepo.path, branchName, settings) : null
  const hostedReviewEntry = hostedReviewCacheKey ? hostedReviewCache[hostedReviewCacheKey] : undefined
  const hostedReview: HostedReviewInfo | null = hostedReviewCacheKey
    ? (hostedReviewEntry?.data ?? null)
    : null

  const linkedGitHubPR = activeWorktree?.linkedPR ?? null
  const linkedGitLabMR = activeWorktree?.linkedGitLabMR ?? null
  const isHostedReviewStateLoading =
    (linkedGitHubPR !== null || linkedGitLabMR !== null) && hostedReviewEntry === undefined
  useEffect(() => {
    if (!isBranchVisible || !activeRepo || isFolder || !branchName || branchName === 'HEAD') {
      return
    }
    if (activeRepo.connectionId) {
      return
    }

    // Why: the Source Control panel renders branch review status directly.
    // When a terminal checkout moves this worktree onto a new branch, we need
    // to fetch that branch's PR/MR immediately instead of waiting for the user
    // to reselect the worktree. The linked ids handle create-from-review
    // worktrees whose local branch differs from the remote head branch.
    void fetchHostedReviewForBranch(activeRepo.path, branchName, { linkedGitHubPR, linkedGitLabMR })
  }, [
    activeRepo,
    branchName,
    fetchHostedReviewForBranch,
    isBranchVisible,
    isFolder,
    linkedGitHubPR,
    linkedGitLabMR
  ])

  const grouped = useMemo(() => {
    const groups = {
      staged: [] as GitStatusEntry[],
      unstaged: [] as GitStatusEntry[],
      untracked: [] as GitStatusEntry[]
    }
    for (const entry of entries) {
      groups[entry.area].push(entry)
    }
    for (const area of SECTION_ORDER) {
      groups[area].sort(compareGitStatusEntries)
    }
    return groups
  }, [entries])

  const normalizedFilter = filterQuery.toLowerCase()

  const filteredGrouped = useMemo(() => {
    if (!normalizedFilter) {
      return grouped
    }
    return {
      staged: grouped.staged.filter((e) => e.path.toLowerCase().includes(normalizedFilter)),
      unstaged: grouped.unstaged.filter((e) => e.path.toLowerCase().includes(normalizedFilter)),
      untracked: grouped.untracked.filter((e) => e.path.toLowerCase().includes(normalizedFilter))
    }
  }, [grouped, normalizedFilter])

  const filteredBranchEntries = useMemo(() => {
    if (!normalizedFilter) {
      return branchEntries
    }
    return branchEntries.filter((e) => e.path.toLowerCase().includes(normalizedFilter))
  }, [branchEntries, normalizedFilter])

  const flatEntries = useMemo(() => {
    const arr: FlatEntry[] = []
    for (const area of SECTION_ORDER) {
      if (!collapsedSections.has(area)) {
        for (const entry of filteredGrouped[area]) {
          arr.push({ key: `${area}::${entry.path}`, entry, area })
        }
      }
    }
    return arr
  }, [filteredGrouped, collapsedSections])

  const [isExecutingBulk, setIsExecutingBulk] = useState(false)
  const pendingDiscardCopy = useMemo<DiscardConfirmationCopy | null>(() => {
    if (!pendingDiscard) {
      return null
    }
    if (pendingDiscard.kind === 'entry') {
      return getDiscardEntryConfirmationCopy(pendingDiscard.entry)
    }
    return getDiscardAreaConfirmationCopy(pendingDiscard.area, pendingDiscard.paths.length)
  }, [pendingDiscard])

  const unresolvedConflicts = useMemo(
    () => entries.filter((entry) => entry.conflictStatus === 'unresolved' && entry.conflictKind),
    [entries]
  )
  const unresolvedConflictReviewEntries = useMemo(
    () =>
      unresolvedConflicts.map((entry) => ({
        path: entry.path,
        conflictKind: entry.conflictKind!
      })),
    [unresolvedConflicts]
  )

  // Why: orphaned draft/error/in-flight entries accumulate when worktrees are
  // removed from the store (long sessions with many create/destroy cycles).
  // Prune them so a deleted-then-reused worktree ID doesn't inherit stale
  // state — especially commitInFlightRef, which would permanently disable
  // Commit for that ID if left stuck at `true`.
  useEffect(() => {
    const pruneRecord = <T,>(prev: Record<string, T>): Record<string, T> => {
      let changed = false
      const next: Record<string, T> = {}
      for (const key of Object.keys(prev)) {
        if (worktreeMap.has(key)) {
          next[key] = prev[key]
        } else {
          changed = true
        }
      }
      return changed ? next : prev
    }
    setCommitDrafts((prev) => pruneRecord(prev))
    setCommitErrors((prev) => pruneRecord(prev))
    setCommitInFlightByWorktree((prev) => pruneRecord(prev))
    setGenerateInFlightByWorktree((prev) => pruneRecord(prev))
    setGenerateErrors((prev) => pruneRecord(prev))
    // Refs don't need setState — mutate in place to drop stale keys.
    for (const key of Object.keys(commitInFlightRef.current)) {
      if (!worktreeMap.has(key)) {
        delete commitInFlightRef.current[key]
      }
    }
    for (const key of Object.keys(generateInFlightRef.current)) {
      if (!worktreeMap.has(key)) {
        delete generateInFlightRef.current[key]
      }
    }
  }, [worktreeMap])

  // Why: the sidebar no longer uses key={activeWorktreeId} to force a full
  // remount on worktree switch (that caused an IPC storm on Windows).
  // Instead, reset worktree-specific local state here so the previous
  // worktree's UI state doesn't leak into the new one.
  useEffect(() => {
    setScope('all')
    setCollapsedSections(new Set())
    setBaseRefDialogOpen(false)
    setPendingDiscard(null)
    // Why: do NOT reset defaultBaseRef here. It is repo-scoped, not
    // worktree-scoped, and is resolved by the effect above on activeRepo
    // change. Resetting it to a hard-coded 'origin/main' on every worktree
    // switch within the same repo clobbered the correct value (e.g.
    // 'origin/master' for repos whose default branch isn't main), causing
    // a persistent "Branch compare unavailable" until the user switched
    // repos and back to re-trigger the resolver.
    setFilterQuery('')
    setIsExecutingBulk(false)
    // Why: no reset for commit-in-flight state — it now lives in a per-worktree
    // map, so it cannot leak across worktrees. Resetting here would actually
    // clear in-flight state for the *incoming* worktree if the user is coming
    // back to a worktree mid-commit, re-enabling the button while the commit
    // still runs.
  }, [activeWorktreeId])

  // Why: returns true on success so compound actions ("Commit & Push" etc.)
  // can skip the follow-up remote operation when the commit itself failed.
  const handleCommit = useCallback(async (): Promise<boolean> => {
    if (!activeWorktreeId || !worktreePath) {
      return false
    }
    const message = commitMessage.trim()
    if (!message || grouped.staged.length === 0 || unresolvedConflicts.length > 0) {
      return false
    }

    if (commitInFlightRef.current[activeWorktreeId]) {
      return false
    }
    commitInFlightRef.current[activeWorktreeId] = true

    const connectionId = getConnectionId(activeWorktreeId) ?? undefined
    setCommitInFlightByWorktree((prev) => ({ ...prev, [activeWorktreeId]: true }))
    setCommitErrors((prev) => ({ ...prev, [activeWorktreeId]: null }))
    try {
      const commitResult = await commitRuntimeGit(
        {
          settings: useAppStore.getState().settings,
          worktreeId: activeWorktreeId,
          worktreePath,
          connectionId
        },
        message
      )
      if (!commitResult.success) {
        setCommitErrors((prev) => ({
          ...prev,
          [activeWorktreeId]: commitResult.error ?? 'Commit failed'
        }))
        return false
      }

      // Why: the textarea stays enabled during the in-flight commit (only the
      // button is disabled), so the user can keep typing after clicking Commit.
      // Unconditionally clearing the draft here would silently discard those
      // in-progress edits — the commit used the OLD `message` captured in this
      // closure, so the dropped text would never have been committed either.
      // Only clear when the current draft still matches what we committed.
      setCommitDrafts((prev) => {
        const current = prev[activeWorktreeId]
        if (current !== undefined && current.trim() !== message) {
          // User typed more after submit — preserve their in-progress edits.
          return prev
        }
        return writeCommitDraftForWorktree(prev, activeWorktreeId, '')
      })
      setCommitErrors((prev) => ({ ...prev, [activeWorktreeId]: null }))
      void refreshActiveGitStatusAfterMutation()
      // Why: flip branchSummary to 'loading' synchronously so the empty-state
      // guard
      //   (!hasUncommittedEntries && branchSummary.status === 'ready' &&
      //    branchEntries.length === 0)
      // doesn't briefly read true between setGitStatus clearing the
      // uncommitted list and the next branchCompare poll landing the new
      // commit. Without this flip "No changes on this branch" flashes for
      // the full poll-interval window.
      //
      // Then fire-and-forget refreshBranchCompare so the "Committed on
      // Branch" section repopulates as soon as the IPC returns instead of
      // waiting up to 5 seconds for the next poll. Unawaited on purpose:
      // compound flows (runCompoundCommitAction) need handleCommit to
      // resolve immediately so the push step starts without delay. Errors
      // here are best-effort — the polling tick will retry.
      if (effectiveBaseRef) {
        beginGitBranchCompareRequest(
          activeWorktreeId,
          `${activeWorktreeId}:${effectiveBaseRef}:${Date.now()}:post-commit`,
          effectiveBaseRef
        )
      }
      void refreshBranchCompareRef.current()
      return true
    } catch (error) {
      setCommitErrors((prev) => ({
        ...prev,
        [activeWorktreeId]: error instanceof Error ? error.message : 'Commit failed'
      }))
      return false
    } finally {
      setCommitInFlightByWorktree((prev) => ({ ...prev, [activeWorktreeId]: false }))
      commitInFlightRef.current[activeWorktreeId] = false
    }
  }, [
    activeWorktreeId,
    beginGitBranchCompareRequest,
    commitMessage,
    effectiveBaseRef,
    grouped.staged.length,
    refreshActiveGitStatusAfterMutation,
    unresolvedConflicts.length,
    worktreePath
  ])

  const handleGenerate = useCallback(async (): Promise<void> => {
    if (!activeWorktreeId || !worktreePath) {
      return
    }
    if (generateInFlightRef.current[activeWorktreeId]) {
      return
    }
    if (!commitMessageAi?.enabled || !commitMessageAi.agentId) {
      return
    }

    if (commitMessageAi.agentId === 'custom') {
      const command = commitMessageAi.customAgentCommand?.trim() ?? ''
      if (!command) {
        setGenerateErrors((prev) => ({
          ...prev,
          [activeWorktreeId]:
            'Custom command is empty. Add one in Settings → Git → AI Commit Messages.'
        }))
        return
      }
    }

    generateInFlightRef.current[activeWorktreeId] = true
    const connectionId = getConnectionId(activeWorktreeId) ?? undefined
    setGenerateInFlightByWorktree((prev) => ({ ...prev, [activeWorktreeId]: true }))
    setGenerateErrors((prev) => ({ ...prev, [activeWorktreeId]: null }))
    try {
      const result = (await window.api.git.generateCommitMessage({
        worktreePath,
        connectionId
      })) as
        | { success: true; message: string; agentLabel?: string }
        | { success: false; error: string; canceled?: boolean }

      if (!result.success) {
        // Why: cancellation is a deliberate user action, not a failure to
        // surface. Clear any prior error and stay quiet.
        if (result.canceled) {
          setGenerateErrors((prev) => ({ ...prev, [activeWorktreeId]: null }))
          return
        }
        setGenerateErrors((prev) => ({
          ...prev,
          [activeWorktreeId]: result.error
        }))
        return
      }

      // Why: race protection — the user may have started typing into the
      // textarea while the agent was running. In that case we silently drop
      // the generated message rather than overwrite their in-progress edits.
      setCommitDrafts((prev) => {
        const current = prev[activeWorktreeId]
        if (current && current.length > 0) {
          return prev
        }
        return writeCommitDraftForWorktree(prev, activeWorktreeId, result.message)
      })
      setGenerateErrors((prev) => ({ ...prev, [activeWorktreeId]: null }))
    } catch (error) {
      setGenerateErrors((prev) => ({
        ...prev,
        [activeWorktreeId]:
          error instanceof Error ? error.message : 'Failed to generate commit message'
      }))
    } finally {
      setGenerateInFlightByWorktree((prev) => ({ ...prev, [activeWorktreeId]: false }))
      generateInFlightRef.current[activeWorktreeId] = false
    }
  }, [activeWorktreeId, commitMessageAi, worktreePath])

  const handleCancelGenerate = useCallback((): void => {
    if (!activeWorktreeId || !worktreePath) {
      return
    }
    if (!generateInFlightRef.current[activeWorktreeId]) {
      return
    }
    const connectionId = getConnectionId(activeWorktreeId) ?? undefined
    // Why: fire-and-forget — the in-flight generateCommitMessage promise
    // resolves with `{canceled: true}` once the kill propagates, which is
    // where the spinner is cleared. Awaiting here would just delay UI feedback.
    void window.api.git.cancelGenerateCommitMessage({ worktreePath, connectionId })
  }, [activeWorktreeId, worktreePath])

  // Why: a single dispatcher for every remote-only action the split button or
  // chevron dropdown can trigger. Keeps the error-swallow pattern in one
  // place — store slices already surface actionable toasts, so additional
  // try/catch here would duplicate the notification.
  const runRemoteAction = useCallback(
    async (kind: 'push' | 'pull' | 'sync' | 'fetch' | 'publish'): Promise<void> => {
      if (!activeWorktreeId || !worktreePath) {
        return
      }
      const connectionId = getConnectionId(activeWorktreeId) ?? undefined
      try {
        if (kind === 'publish') {
          await pushBranch(
            activeWorktreeId,
            worktreePath,
            true,
            connectionId,
            activeWorktree?.pushTarget
          )
          return
        }
        if (kind === 'push') {
          await pushBranch(
            activeWorktreeId,
            worktreePath,
            false,
            connectionId,
            activeWorktree?.pushTarget
          )
          return
        }
        if (kind === 'pull') {
          await pullBranch(activeWorktreeId, worktreePath, connectionId)
          return
        }
        if (kind === 'fetch') {
          await fetchBranch(activeWorktreeId, worktreePath, connectionId)
          return
        }
        await syncBranch(activeWorktreeId, worktreePath, connectionId, activeWorktree?.pushTarget)
      } catch {
        // Why: remote action failures are surfaced by editor-slice actions to keep
        // one consistent toast path and avoid duplicate notifications in the UI.
      }
    },
    [
      activeWorktree?.pushTarget,
      activeWorktreeId,
      fetchBranch,
      pullBranch,
      pushBranch,
      syncBranch,
      worktreePath
    ]
  )

  // Why: compound actions must commit first and only run the follow-up remote
  // op when the commit succeeds. handleCommit's return value carries that
  // signal — a failure leaves commitError populated and short-circuits here
  // so we never push a commit the user didn't actually land. The primary
  // button never takes this path (it always emits a single-action kind);
  // compound flows are reached only from the dropdown, which offers
  // 'commit_push' and 'commit_sync' (there is no 'Commit & Publish' row).
  const runCompoundCommitAction = useCallback(
    async (remoteKind: 'push' | 'sync'): Promise<void> => {
      const ok = await handleCommit()
      if (!ok) {
        return
      }
      await runRemoteAction(remoteKind)
    },
    [handleCommit, runRemoteAction]
  )

  const hasUnstagedChanges = grouped.unstaged.length > 0 || grouped.untracked.length > 0

  const primaryAction: PrimaryAction = useMemo(
    () =>
      resolvePrimaryAction({
        stagedCount: grouped.staged.length,
        hasUnstagedChanges,
        hasMessage: commitMessage.trim().length > 0,
        hasUnresolvedConflicts: unresolvedConflicts.length > 0,
        isCommitting,
        isRemoteOperationActive,
        upstreamStatus: remoteStatus,
        prState: hostedReview?.state ?? null,
        isPRStateLoading: isHostedReviewStateLoading,
        inFlightRemoteOpKind
      }),
    [
      commitMessage,
      grouped.staged.length,
      hasUnstagedChanges,
      isCommitting,
      isRemoteOperationActive,
      inFlightRemoteOpKind,
      isHostedReviewStateLoading,
      hostedReview?.state,
      remoteStatus,
      unresolvedConflicts.length
    ]
  )

  const dropdownItems: DropdownEntry[] = useMemo(
    () =>
      resolveDropdownItems({
        stagedCount: grouped.staged.length,
        hasUnstagedChanges,
        hasMessage: commitMessage.trim().length > 0,
        hasUnresolvedConflicts: unresolvedConflicts.length > 0,
        isCommitting,
        isRemoteOperationActive,
        upstreamStatus: remoteStatus,
        prState: hostedReview?.state ?? null,
        isPRStateLoading: isHostedReviewStateLoading,
        inFlightRemoteOpKind
      }),
    [
      commitMessage,
      grouped.staged.length,
      hasUnstagedChanges,
      isCommitting,
      isRemoteOperationActive,
      inFlightRemoteOpKind,
      isHostedReviewStateLoading,
      hostedReview?.state,
      remoteStatus,
      unresolvedConflicts.length
    ]
  )

  // Why: maps both the primary button click and any chevron dropdown item
  // click to the right handler. Commit-ish kinds flow through handleCommit
  // (which returns a boolean); compound actions use runCompoundCommitAction;
  // pure remote actions go through runRemoteAction.
  const handleActionInvoke = useCallback(
    (kind: DropdownActionKind): void => {
      switch (kind) {
        case 'commit':
          void handleCommit()
          return
        case 'commit_push':
          void runCompoundCommitAction('push')
          return
        case 'commit_sync':
          void runCompoundCommitAction('sync')
          return
        case 'push':
        case 'pull':
        case 'sync':
        case 'fetch':
        case 'publish':
          void runRemoteAction(kind)
          return
        default: {
          // Why: exhaustiveness check — if a new DropdownActionKind is added
          // to the union, TypeScript will flag this assignment so we can't
          // silently drop a case.
          const _exhaustive: never = kind
          void _exhaustive
        }
      }
    },
    [handleCommit, runCompoundCommitAction, runRemoteAction]
  )

  const handleOpenDiff = useCallback(
    (entry: GitStatusEntry) => {
      if (!activeWorktreeId || !worktreePath) {
        return
      }
      if (entry.conflictKind && entry.conflictStatus) {
        if (entry.conflictStatus === 'unresolved') {
          trackConflictPath(activeWorktreeId, entry.path, entry.conflictKind)
        }
        openConflictFile(activeWorktreeId, worktreePath, entry, detectLanguage(entry.path))
        return
      }
      const language = detectLanguage(entry.path)
      const filePath = joinPath(worktreePath, entry.path)
      // Why: unstaged markdown diffs open as a normal edit tab in Changes
      // view mode rather than a dedicated diff tab. This unifies sidebar
      // clicks with the header's Edit|Changes toggle: there is exactly one
      // tab per markdown file, and the sidebar click flips that tab's view
      // mode. Staged diffs still open as a separate diff tab because the
      // staged content is not what the editor would be editing. Non-markdown
      // files keep the existing diff-tab flow until the diff-tab type is
      // eventually collapsed (see reviews/changes-view-mode-plan.md §"Follow-up").
      if (language === 'markdown' && entry.area === 'unstaged') {
        openFile({
          filePath,
          relativePath: entry.path,
          worktreeId: activeWorktreeId,
          language,
          mode: 'edit'
        })
        setEditorViewMode(filePath, 'changes')
        return
      }
      openDiff(activeWorktreeId, filePath, entry.path, language, entry.area === 'staged')
    },
    [
      activeWorktreeId,
      worktreePath,
      trackConflictPath,
      openConflictFile,
      openDiff,
      openFile,
      setEditorViewMode
    ]
  )

  const { selectedKeys, handleSelect, handleContextMenu, clearSelection } =
    useSourceControlSelection({
      flatEntries,
      onOpenDiff: handleOpenDiff,
      containerRef: sourceControlRef
    })

  // clear selection on scope change
  useEffect(() => {
    clearSelection()
  }, [scope, clearSelection])

  // Clear selection on worktree or tab change
  useEffect(() => {
    clearSelection()
  }, [activeWorktreeId, rightSidebarTab, clearSelection])

  const flatEntriesByKey = useMemo(
    () => new Map(flatEntries.map((entry) => [entry.key, entry])),
    [flatEntries]
  )

  const selectedEntries = useMemo(
    () =>
      Array.from(selectedKeys)
        .map((key) => flatEntriesByKey.get(key))
        .filter((entry): entry is FlatEntry => Boolean(entry)),
    [selectedKeys, flatEntriesByKey]
  )

  const bulkStagePaths = useMemo(
    () =>
      selectedEntries
        .filter(
          (entry) =>
            (entry.area === 'unstaged' || entry.area === 'untracked') &&
            entry.entry.conflictStatus !== 'unresolved'
        )
        .map((entry) => entry.entry.path),
    [selectedEntries]
  )

  const bulkUnstagePaths = useMemo(
    () =>
      selectedEntries.filter((entry) => entry.area === 'staged').map((entry) => entry.entry.path),
    [selectedEntries]
  )

  const selectedKeySet = selectedKeys

  const handleBulkStage = useCallback(async () => {
    if (!worktreePath || bulkStagePaths.length === 0) {
      return
    }
    setIsExecutingBulk(true)
    try {
      const connectionId = getConnectionId(activeWorktreeId ?? null) ?? undefined
      await bulkStageRuntimeGitPaths(
        {
          settings: useAppStore.getState().settings,
          worktreeId: activeWorktreeId,
          worktreePath,
          connectionId
        },
        bulkStagePaths
      )
      await refreshActiveGitStatusAfterMutation()
      clearSelection()
    } finally {
      setIsExecutingBulk(false)
    }
  }, [
    worktreePath,
    bulkStagePaths,
    clearSelection,
    activeWorktreeId,
    refreshActiveGitStatusAfterMutation
  ])

  const handleBulkUnstage = useCallback(async () => {
    if (!worktreePath || bulkUnstagePaths.length === 0) {
      return
    }
    setIsExecutingBulk(true)
    try {
      const connectionId = getConnectionId(activeWorktreeId ?? null) ?? undefined
      await bulkUnstageRuntimeGitPaths(
        {
          settings: useAppStore.getState().settings,
          worktreeId: activeWorktreeId,
          worktreePath,
          connectionId
        },
        bulkUnstagePaths
      )
      await refreshActiveGitStatusAfterMutation()
      clearSelection()
    } finally {
      setIsExecutingBulk(false)
    }
  }, [
    worktreePath,
    bulkUnstagePaths,
    clearSelection,
    activeWorktreeId,
    refreshActiveGitStatusAfterMutation
  ])

  // Why: "Stage all" on the Changes section intentionally skips unresolved
  // conflict rows. `git add` on a conflicted file silently clears the `u`
  // record — the only live signal we have — before the user has reviewed it,
  // which mirrors the per-row Stage suppression above.
  const handleStageAllInArea = useCallback(
    async (area: 'unstaged' | 'untracked') => {
      if (!worktreePath || isExecutingBulk) {
        return
      }
      const paths = getStageAllPaths(grouped[area], area)
      if (paths.length === 0) {
        return
      }
      setIsExecutingBulk(true)
      try {
        const connectionId = getConnectionId(activeWorktreeId ?? null) ?? undefined
        await bulkStageRuntimeGitPaths(
          {
            settings: useAppStore.getState().settings,
            worktreeId: activeWorktreeId,
            worktreePath,
            connectionId
          },
          paths
        )
        await refreshActiveGitStatusAfterMutation()
        clearSelection()
      } finally {
        setIsExecutingBulk(false)
      }
    },
    [
      worktreePath,
      grouped,
      activeWorktreeId,
      isExecutingBulk,
      clearSelection,
      refreshActiveGitStatusAfterMutation
    ]
  )

  // Why: 'stage' primary stages every unstaged + untracked path in one
  // bulkStage call. It bypasses handleActionInvoke because that handler is
  // typed to DropdownActionKind and 'stage' is intentionally not in the
  // dropdown union — the dropdown surface is unchanged.
  const handleStageAllPrimary = useCallback(async (): Promise<void> => {
    if (!worktreePath || isExecutingBulk) {
      return
    }
    const filePaths = [
      ...getStageAllPaths(grouped.unstaged, 'unstaged'),
      ...getStageAllPaths(grouped.untracked, 'untracked')
    ]
    if (filePaths.length === 0) {
      return
    }
    setIsExecutingBulk(true)
    try {
      const connectionId = getConnectionId(activeWorktreeId ?? null) ?? undefined
      await bulkStageRuntimeGitPaths(
        {
          settings: useAppStore.getState().settings,
          worktreeId: activeWorktreeId,
          worktreePath,
          connectionId
        },
        filePaths
      )
      await refreshActiveGitStatusAfterMutation()
      clearSelection()
    } finally {
      setIsExecutingBulk(false)
    }
  }, [
    worktreePath,
    isExecutingBulk,
    grouped,
    activeWorktreeId,
    clearSelection,
    refreshActiveGitStatusAfterMutation
  ])

  // Why: PrimaryActionKind is narrowed to the single-action kinds the
  // primary can emit ('commit' | 'stage' | 'push' | 'pull' | 'sync' |
  // 'publish') — compound commit_* kinds are dropdown-only. An exhaustive
  // switch keeps the mapping honest: if a new PrimaryActionKind is added,
  // TypeScript lights up the missing case instead of silently falling
  // through. 'stage' routes to a dedicated primary-only handler because
  // handleActionInvoke is typed to DropdownActionKind.
  const handlePrimaryClick = useCallback((): void => {
    switch (primaryAction.kind) {
      case 'stage':
        void handleStageAllPrimary()
        return
      case 'commit':
      case 'push':
      case 'pull':
      case 'sync':
      case 'publish':
        handleActionInvoke(primaryAction.kind)
        return
      default: {
        const _exhaustive: never = primaryAction.kind
        void _exhaustive
      }
    }
  }, [handleActionInvoke, handleStageAllPrimary, primaryAction.kind])

  const handleUnstageAll = useCallback(async () => {
    if (!worktreePath || isExecutingBulk) {
      return
    }
    const paths = getUnstageAllPaths(grouped.staged)
    if (paths.length === 0) {
      return
    }
    setIsExecutingBulk(true)
    try {
      const connectionId = getConnectionId(activeWorktreeId ?? null) ?? undefined
      await bulkUnstageRuntimeGitPaths(
        {
          settings: useAppStore.getState().settings,
          worktreeId: activeWorktreeId,
          worktreePath,
          connectionId
        },
        paths
      )
      await refreshActiveGitStatusAfterMutation()
      clearSelection()
    } finally {
      setIsExecutingBulk(false)
    }
  }, [
    worktreePath,
    grouped.staged,
    activeWorktreeId,
    isExecutingBulk,
    clearSelection,
    refreshActiveGitStatusAfterMutation
  ])

  const refreshBranchCompare = useCallback(async () => {
    if (!activeWorktreeId || !worktreePath || !effectiveBaseRef || isFolder) {
      return
    }

    const requestKey = `${activeWorktreeId}:${effectiveBaseRef}:${Date.now()}`
    const existingSummary =
      useAppStore.getState().gitBranchCompareSummaryByWorktree[activeWorktreeId]

    // Why: only show the loading spinner for the very first branch compare
    // request, or when the base ref has changed (user picked a new one, or
    // getBaseRefDefault corrected a stale cross-repo value).  Polling retries
    // — whether the previous result was 'ready' *or* an error — keep the
    // current UI visible until the new IPC result arrives.  Resetting to
    // 'loading' on every 5-second poll when the compare is in an error state
    // caused a visible loading→error→loading→error flicker.
    const baseRefChanged = existingSummary && existingSummary.baseRef !== effectiveBaseRef
    const shouldResetToLoading = !existingSummary || baseRefChanged
    if (shouldResetToLoading) {
      beginGitBranchCompareRequest(activeWorktreeId, requestKey, effectiveBaseRef)
    } else {
      useAppStore.setState((s) => ({
        gitBranchCompareRequestKeyByWorktree: {
          ...s.gitBranchCompareRequestKeyByWorktree,
          [activeWorktreeId]: requestKey
        }
      }))
    }

    try {
      const connectionId = getConnectionId(activeWorktreeId ?? null) ?? undefined
      const result = await getRuntimeGitBranchCompare(
        {
          settings: useAppStore.getState().settings,
          worktreeId: activeWorktreeId,
          worktreePath,
          connectionId
        },
        effectiveBaseRef
      )
      setGitBranchCompareResult(activeWorktreeId, requestKey, result)
    } catch (error) {
      setGitBranchCompareResult(activeWorktreeId, requestKey, {
        summary: {
          baseRef: effectiveBaseRef,
          baseOid: null,
          compareRef: branchName,
          headOid: null,
          mergeBase: null,
          changedFiles: 0,
          status: 'error',
          errorMessage: error instanceof Error ? error.message : 'Branch compare failed'
        },
        entries: []
      })
    }
  }, [
    activeWorktreeId,
    beginGitBranchCompareRequest,
    branchName,
    effectiveBaseRef,
    isFolder,
    setGitBranchCompareResult,
    worktreePath
  ])

  const refreshBranchCompareRef = useRef(refreshBranchCompare)
  refreshBranchCompareRef.current = refreshBranchCompare

  useEffect(() => {
    if (!activeWorktreeId || !worktreePath || !isBranchVisible || !effectiveBaseRef || isFolder) {
      return
    }

    void refreshBranchCompareRef.current()
    const refreshIfFocused = (): void => {
      if (document.hasFocus()) {
        void refreshBranchCompareRef.current()
      }
    }
    // Why: branch compare shells out to git every tick. The panel only needs
    // background freshness while Orca is focused; on focus we refresh
    // immediately so hidden-window time does not burn subprocess work.
    const intervalId = window.setInterval(refreshIfFocused, BRANCH_REFRESH_INTERVAL_MS)
    window.addEventListener('focus', refreshIfFocused)
    return () => {
      window.clearInterval(intervalId)
      window.removeEventListener('focus', refreshIfFocused)
    }
  }, [activeWorktreeId, effectiveBaseRef, isBranchVisible, isFolder, worktreePath])

  useEffect(() => {
    // Why: gate on isBranchVisible so we don't spawn git processes while the
    // sidebar is closed. Store-slice remote operations refresh upstream-status
    // on success anyway, so the user's first sidebar open will show accurate
    // state.
    if (!activeWorktreeId || !worktreePath || isFolder || !isBranchVisible) {
      return
    }
    const connectionId = getConnectionId(activeWorktreeId) ?? undefined
    void fetchUpstreamStatus(activeWorktreeId, worktreePath, connectionId)
  }, [activeWorktreeId, fetchUpstreamStatus, isBranchVisible, isFolder, worktreePath])

  const toggleSection = useCallback((section: string) => {
    setCollapsedSections((prev) => {
      const next = new Set(prev)
      if (next.has(section)) {
        next.delete(section)
      } else {
        next.add(section)
      }
      return next
    })
  }, [])

  const openCommittedDiff = useCallback(
    (entry: GitBranchChangeEntry) => {
      if (
        !activeWorktreeId ||
        !worktreePath ||
        !branchSummary ||
        branchSummary.status !== 'ready'
      ) {
        return
      }
      openBranchDiff(
        activeWorktreeId,
        worktreePath,
        entry,
        branchSummary,
        detectLanguage(entry.path)
      )
    },
    [activeWorktreeId, branchSummary, openBranchDiff, worktreePath]
  )

  // Why: a note's filePath is the same relative path used by GitStatusEntry /
  // GitBranchChangeEntry, so we can route the click to whichever diff surface
  // currently owns that file. Prefer the `unstaged` entry when a path is also
  // staged — diff comments are authored against the working-tree (unstaged)
  // diff card. Fall back to the branch compare, and finally just open the
  // file as a normal editor tab so the user still gets navigation when
  // neither side has the path anymore. When `commentId` is supplied and the
  // route lands on a diff surface, also stamp scrollToDiffCommentId so the
  // diff decorator scrolls that note into view; we clear any prior request
  // first, so the editor-tab fallback then leaves the global null and a
  // future DiffViewer mount can't accidentally consume a stale id.
  const handleOpenComment = useCallback(
    (filePath: string, commentId?: string) => {
      if (!activeWorktreeId || !worktreePath) {
        return
      }
      // Defensively clear any dangling prior scroll request before routing
      // this click; only the diff branches below will re-stamp it.
      setScrollToDiffCommentId(null)
      const matches = entries.filter((e) => e.path === filePath)
      const uncommitted =
        matches.find((e) => e.area === 'unstaged') ??
        matches.find((e) => e.area === 'untracked') ??
        matches[0]
      if (uncommitted) {
        handleOpenDiff(uncommitted)
        if (commentId) {
          setScrollToDiffCommentId(commentId)
        }
        return
      }
      const branchEntry = branchEntries.find((e) => e.path === filePath)
      if (branchEntry && branchSummary?.status === 'ready') {
        openCommittedDiff(branchEntry)
        if (commentId) {
          setScrollToDiffCommentId(commentId)
        }
        return
      }
      // Why: fall through to a normal editor tab when neither the working-tree
      // nor branch-compare diff has the file (e.g. the change has since been
      // committed and merged, but the note still references the file). Force
      // the editor tab into 'changes' mode and stamp scrollToDiffCommentId so
      // the DiffViewer that EditorContent renders in changes mode picks up
      // the scroll request — same surface the user can flip into manually
      // via the editor's Edit/Changes toggle.
      const absPath = joinPath(worktreePath, filePath)
      const language = detectLanguage(filePath)
      openFile({
        filePath: absPath,
        relativePath: filePath,
        worktreeId: activeWorktreeId,
        language,
        mode: 'edit'
      })
      if (commentId) {
        setEditorViewMode(absPath, 'changes')
        setScrollToDiffCommentId(commentId)
      }
    },
    [
      activeWorktreeId,
      branchEntries,
      branchSummary,
      entries,
      handleOpenDiff,
      openCommittedDiff,
      openFile,
      setEditorViewMode,
      setScrollToDiffCommentId,
      worktreePath
    ]
  )

  const handleStage = useCallback(
    async (filePath: string) => {
      if (!worktreePath) {
        return
      }
      try {
        const connectionId = getConnectionId(activeWorktreeId ?? null) ?? undefined
        await stageRuntimeGitPath(
          {
            settings: useAppStore.getState().settings,
            worktreeId: activeWorktreeId,
            worktreePath,
            connectionId
          },
          filePath
        )
        await refreshActiveGitStatusAfterMutation()
      } catch {
        // git operation failed silently
      }
    },
    [worktreePath, activeWorktreeId, refreshActiveGitStatusAfterMutation]
  )

  const handleUnstage = useCallback(
    async (filePath: string) => {
      if (!worktreePath) {
        return
      }
      try {
        const connectionId = getConnectionId(activeWorktreeId ?? null) ?? undefined
        await unstageRuntimeGitPath(
          {
            settings: useAppStore.getState().settings,
            worktreeId: activeWorktreeId,
            worktreePath,
            connectionId
          },
          filePath
        )
        await refreshActiveGitStatusAfterMutation()
      } catch {
        // git operation failed silently
      }
    },
    [worktreePath, activeWorktreeId, refreshActiveGitStatusAfterMutation]
  )

  // Why: split into two variants — `discardSingle` throws so bulk callers can
  // aggregate failures into a single toast via `runDiscardAllForArea`'s
  // onError, while `handleDiscard` swallows for the per-row fire-and-forget UI
  // contract (no individual failure toast).
  const discardSingle = useCallback(
    async (filePath: string) => {
      if (!worktreePath || !activeWorktreeId) {
        return
      }
      // Why: git discard replaces the working tree version of this file. Any
      // pending editor autosave must be quiesced first so it cannot recreate
      // the discarded edits after git restores the file.
      await requestEditorSaveQuiesce({
        worktreeId: activeWorktreeId,
        worktreePath,
        relativePath: filePath
      })
      const connectionId = getConnectionId(activeWorktreeId ?? null) ?? undefined
      await discardRuntimeGitPath(
        {
          settings: useAppStore.getState().settings,
          worktreeId: activeWorktreeId,
          worktreePath,
          connectionId
        },
        filePath
      )
      notifyEditorExternalFileChange({
        worktreeId: activeWorktreeId,
        worktreePath,
        relativePath: filePath
      })
    },
    [activeWorktreeId, worktreePath]
  )

  const discardMany = useCallback(
    async (filePaths: string[]) => {
      if (!worktreePath || !activeWorktreeId) {
        return
      }
      // Why: bulk discard replaces many working-tree files at once. Quiesce
      // any matching editor autosaves before git mutates the files so a delayed
      // save cannot recreate edits after the restore.
      await Promise.all(
        filePaths.map((relativePath) =>
          requestEditorSaveQuiesce({
            worktreeId: activeWorktreeId,
            worktreePath,
            relativePath
          })
        )
      )
      const connectionId = getConnectionId(activeWorktreeId) ?? undefined
      await window.api.git.bulkDiscard({ worktreePath, filePaths, connectionId })
      for (const relativePath of filePaths) {
        notifyEditorExternalFileChange({
          worktreeId: activeWorktreeId,
          worktreePath,
          relativePath
        })
      }
    },
    [activeWorktreeId, worktreePath]
  )

  const handleDiscard = useCallback(
    async (filePath: string) => {
      try {
        await discardSingle(filePath)
        await refreshActiveGitStatusAfterMutation()
      } catch {
        // Why: per-row discard is fire-and-forget for the UI; failures are not
        // surfaced individually. Bulk callers use `discardSingle` directly so
        // they can aggregate failures into a single toast.
      }
    },
    [discardSingle, refreshActiveGitStatusAfterMutation]
  )

  // Why: "Discard all" mirrors the per-row discard rules — it skips unresolved
  // and resolved_locally rows because discarding those can silently re-create
  // the conflict or lose the resolution (no v1 UX to explain this clearly).
  // The happy path uses bulk discard IPC; the sequencing helper falls back to
  // per-file discard when an older SSH relay does not support that method yet.
  // The sequencing + filter rules live in discard-all-sequence.ts so they can
  // be unit-tested independently of the full component (staged area needs a
  // bulk-unstage first, and a failed unstage must skip the discard loop).
  const handleRevertAllInArea = useCallback(
    async (area: DiscardAllArea, confirmedPaths?: readonly string[]) => {
      if (!worktreePath || !activeWorktreeId || isExecutingBulk) {
        return
      }
      const paths = confirmedPaths ? [...confirmedPaths] : getDiscardAllPaths(grouped[area], area)
      if (paths.length === 0) {
        return
      }
      setIsExecutingBulk(true)
      try {
        const connectionId = getConnectionId(activeWorktreeId) ?? undefined
        // Why: `onError` fires once per failure — both for the bulk-unstage
        // pre-step and for each per-file discard failure. Aggregate into one
        // toast after the sequence completes so a partial failure across N
        // files doesn't spam N error toasts.
        const errors: unknown[] = []
        const result = await runDiscardAllForArea(area, paths, {
          bulkUnstage: (filePaths) =>
            bulkUnstageRuntimeGitPaths(
              {
                settings: useAppStore.getState().settings,
                worktreeId: activeWorktreeId,
                worktreePath,
                connectionId
              },
              filePaths
            ),
          discardMany,
          discardOne: discardSingle,
          onError: (error) => {
            errors.push(error)
            console.error('[SourceControl] discard-all failure', error)
          }
        })
        if (result.aborted) {
          toast.error('Discard all failed — unable to unstage files before discard', {
            description: errors[0] instanceof Error ? errors[0].message : undefined
          })
        } else if (result.failed.length > 0) {
          // Why: only include the first error message to avoid a huge toast
          // body on bulk failures; a short sample of failed paths gives users
          // enough context to retry or investigate.
          const firstMsg = errors[0] instanceof Error ? errors[0].message : undefined
          const sample = result.failed.slice(0, 3).join(', ')
          const more = result.failed.length > 3 ? `, +${result.failed.length - 3} more` : ''
          toast.error(
            `Failed to discard ${result.failed.length} file${result.failed.length === 1 ? '' : 's'}`,
            {
              description: firstMsg ? `${firstMsg} (e.g. ${sample}${more})` : `${sample}${more}`
            }
          )
        }
        if (!result.aborted) {
          await refreshActiveGitStatusAfterMutation()
          clearSelection()
        }
      } finally {
        setIsExecutingBulk(false)
      }
    },
    [
      worktreePath,
      activeWorktreeId,
      grouped,
      isExecutingBulk,
      clearSelection,
      discardMany,
      discardSingle,
      refreshActiveGitStatusAfterMutation
    ]
  )

  const requestDiscardAllInArea = useCallback(
    (area: DiscardAllArea): void => {
      if (!worktreePath || !activeWorktreeId || isExecutingBulk) {
        return
      }
      const paths = getDiscardAllPaths(grouped[area], area)
      if (paths.length === 0) {
        return
      }
      setPendingDiscard({ kind: 'area', area, paths })
    },
    [activeWorktreeId, grouped, isExecutingBulk, worktreePath]
  )

  const requestDiscardEntry = useCallback(
    (entry: GitStatusEntry): void => {
      if (!worktreePath || !activeWorktreeId || isExecutingBulk) {
        return
      }
      setPendingDiscard({ kind: 'entry', entry })
    },
    [activeWorktreeId, isExecutingBulk, worktreePath]
  )

  const confirmPendingDiscard = useCallback((): void => {
    const pending = pendingDiscard
    if (!pending) {
      return
    }
    setPendingDiscard(null)
    if (pending.kind === 'entry') {
      void handleDiscard(pending.entry.path)
      return
    }
    void handleRevertAllInArea(pending.area, pending.paths)
  }, [handleDiscard, handleRevertAllInArea, pendingDiscard])

  if (!activeWorktree || !activeRepo || !worktreePath) {
    return (
      <div className="flex items-center justify-center h-full text-xs text-muted-foreground px-4 text-center">
        Select a worktree to view changes
      </div>
    )
  }
  if (isFolder) {
    return (
      <div className="flex items-center justify-center h-full text-xs text-muted-foreground px-4 text-center">
        Source Control is only available for Git repositories
      </div>
    )
  }

  const hasFilteredUncommittedEntries =
    filteredGrouped.staged.length > 0 ||
    filteredGrouped.unstaged.length > 0 ||
    filteredGrouped.untracked.length > 0
  const hasFilteredBranchEntries = filteredBranchEntries.length > 0
  const showGenericEmptyState =
    !hasUncommittedEntries && branchSummary?.status === 'ready' && branchEntries.length === 0
  const currentWorktreeId = activeWorktree.id
  const PendingDiscardIcon = pendingDiscardCopy?.confirmLabel.startsWith('Delete') ? Trash : Undo2

  return (
    <>
      <div ref={sourceControlRef} className="relative flex h-full flex-col overflow-hidden">
        <div className="flex items-center px-3 pt-2 border-b border-border">
          {(['all', 'uncommitted'] as const).map((value) => (
            <button
              key={value}
              type="button"
              className={cn(
                'px-3 pb-2 text-xs font-medium transition-colors border-b-2 -mb-px',
                scope === value
                  ? 'border-foreground text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              )}
              onClick={() => setScope(value)}
            >
              {value === 'all' ? 'All' : 'Uncommitted'}
            </button>
          ))}
          {hostedReview && (
            <div className="ml-auto mb-1.5 flex items-center gap-1.5 min-w-0 text-[11.5px] leading-none">
              <HostedReviewIcon review={hostedReview} className="size-3 shrink-0" />
              <a
                href={hostedReview.url}
                target="_blank"
                rel="noreferrer"
                className="text-foreground opacity-80 font-medium shrink-0 hover:text-foreground hover:underline"
                onClick={(e) => e.stopPropagation()}
              >
                {hostedReview.provider === 'gitlab' ? 'MR' : 'PR'} #{hostedReview.number}
              </a>
            </div>
          )}
        </div>

        {scope === 'all' && (
          <div className="border-b border-border px-3 py-2">
            <CompareSummary
              summary={branchSummary}
              onChangeBaseRef={() => setBaseRefDialogOpen(true)}
              onRetry={() => void refreshBranchCompare()}
            />
          </div>
        )}

        {/* Why: Diff-comments live on the worktree and apply across every diff
            view the user opens. The header row expands inline to show per-file
            comment previews plus a Copy-all action so the user can hand the
            set off to whichever tool they want without leaving the sidebar.
            Hidden when count is 0: notes are created from the diff view, so
            an empty Notes shelf in the sidebar is pure chrome — it adds a
            border, a row of space, and an expand control that only reveals
            a redirect hint. */}
        {activeWorktreeId && worktreePath && diffCommentCount > 0 && (
          <div className="border-b border-border">
            <div className="flex items-center gap-1 pl-3 pr-2 py-1.5">
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-xs text-muted-foreground hover:text-foreground transition-colors"
                onClick={() => setDiffCommentsExpanded((prev) => !prev)}
                aria-expanded={diffCommentsExpanded}
                title={diffCommentsExpanded ? 'Collapse notes' : 'Expand notes'}
              >
                <ChevronDown
                  className={cn(
                    'size-3 shrink-0 transition-transform',
                    !diffCommentsExpanded && '-rotate-90'
                  )}
                />
                <MessageSquare className="size-3.5 shrink-0" />
                <span>Notes</span>
                {diffCommentCount > 0 && (
                  <span className="text-[11px] leading-none text-muted-foreground tabular-nums">
                    {diffCommentCount}
                  </span>
                )}
              </button>
              <DropdownMenu>
                <TooltipProvider delayDuration={400}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          className="inline-flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                          aria-label="Send notes to a new agent"
                        >
                          <Send className="size-3.5" />
                        </button>
                      </DropdownMenuTrigger>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" sideOffset={6}>
                      Send notes to a new agent
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
                <DropdownMenuContent align="end" className="min-w-[180px]">
                  <QuickLaunchAgentMenuItems
                    worktreeId={activeWorktreeId}
                    groupId={activeGroupId ?? activeWorktreeId}
                    onFocusTerminal={focusTerminalTabSurface}
                    prompt={diffCommentsPrompt}
                    launchSource="diff_notes_send"
                  />
                </DropdownMenuContent>
              </DropdownMenu>
              {diffCommentCount > 0 && (
                <TooltipProvider delayDuration={400}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        className="inline-flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                        onClick={() => void handleCopyDiffComments()}
                        aria-label="Copy all notes to clipboard"
                      >
                        {diffCommentsCopied ? (
                          <Check className="size-3.5" />
                        ) : (
                          <Copy className="size-3.5" />
                        )}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" sideOffset={6}>
                      Copy all notes
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              )}
            </div>
            {diffCommentsExpanded && (
              <DiffCommentsInlineList
                comments={diffCommentsForActive}
                onDelete={(id) => void deleteDiffComment(activeWorktreeId, id)}
                onOpen={(filePath, commentId) => handleOpenComment(filePath, commentId)}
              />
            )}
          </div>
        )}

        {/* Filter input for searching changed files across all sections */}
        <div className="flex items-center gap-1.5 border-b border-border px-3 py-1.5">
          <Search className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            ref={filterInputRef}
            type="text"
            value={filterQuery}
            onChange={(e) => setFilterQuery(e.target.value)}
            placeholder="Filter files…"
            className="flex-1 min-w-0 bg-transparent text-xs text-foreground placeholder:text-muted-foreground/60 outline-none"
          />
          {filterQuery && (
            <button
              type="button"
              className="shrink-0 text-muted-foreground hover:text-foreground"
              onClick={() => {
                setFilterQuery('')
                filterInputRef.current?.focus()
              }}
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>

        <div
          className="relative flex-1 overflow-auto scrollbar-sleek py-1"
          style={{ paddingBottom: selectedKeys.size > 0 ? 50 : undefined }}
        >
          {unresolvedConflictReviewEntries.length > 0 && (
            <div className="px-3 pb-2">
              <ConflictSummaryCard
                conflictOperation={conflictOperation}
                unresolvedCount={unresolvedConflictReviewEntries.length}
                onReview={() => {
                  if (!activeWorktreeId || !worktreePath) {
                    return
                  }
                  openConflictReview(
                    activeWorktreeId,
                    worktreePath,
                    unresolvedConflictReviewEntries,
                    'live-summary'
                  )
                }}
              />
            </div>
          )}
          {/* Why: show operation banner when rebase/merge/cherry-pick is in progress
              but there are no unresolved conflicts (e.g. between rebase steps, or
              after resolving all conflicts before running --continue). The
              ConflictSummaryCard handles the "has conflicts" case above. */}
          {unresolvedConflictReviewEntries.length === 0 && conflictOperation !== 'unknown' && (
            <div className="px-3 pb-2">
              <OperationBanner conflictOperation={conflictOperation} />
            </div>
          )}

          {scope === 'all' && showGenericEmptyState && !normalizedFilter ? (
            <EmptyState
              heading="No changes on this branch"
              supportingText={`This worktree is clean and this branch has no changes ahead of ${branchSummary.baseRef}`}
            />
          ) : null}

          {scope === 'uncommitted' && !hasUncommittedEntries && !normalizedFilter && (
            <EmptyState
              heading="No uncommitted changes"
              supportingText="All changes have been committed"
            />
          )}

          {normalizedFilter &&
            !hasFilteredUncommittedEntries &&
            (scope === 'uncommitted' || !hasFilteredBranchEntries) && (
              <EmptyState
                heading="No matching files"
                supportingText={`No changed files match "${filterQuery}"`}
              />
            )}

          {/* Why: keep CommitArea mounted across all source-control states.
              The split-button primary rotates through Push / Pull / Sync /
              Publish on a clean tree and disables Commit with a "Nothing to
              commit" tooltip when nothing is staged — gating on
              hasUncommittedEntries (added by #1448 for the older Commit-only
              design) would unmount the whole action surface on clean
              worktrees and tear it down mid-commit when the staged list
              clears. */}
          {(scope === 'all' || scope === 'uncommitted') && (
            <CommitArea
              commitMessage={commitMessage}
              commitError={commitError}
              isCommitting={isCommitting}
              aiEnabled={commitMessageAi?.enabled === true}
              aiAgentConfigured={
                commitMessageAi?.enabled === true &&
                commitMessageAi.agentId !== null &&
                // Why: 'custom' is configured only once the user types a command.
                // Without this guard, Generate would spawn an empty command and
                // fail with a confusing error.
                (commitMessageAi.agentId !== 'custom' ||
                  (commitMessageAi.customAgentCommand ?? '').trim().length > 0)
              }
              isGenerating={isGenerating}
              generateError={generateError}
              stagedCount={grouped.staged.length}
              hasUnresolvedConflicts={unresolvedConflicts.length > 0}
              isRemoteOperationActive={isRemoteOperationActive}
              inFlightRemoteOpKind={inFlightRemoteOpKind}
              primaryAction={primaryAction}
              dropdownItems={dropdownItems}
              onCommitMessageChange={(value) => {
                if (!activeWorktreeId) {
                  return
                }
                setCommitDrafts((prev) =>
                  writeCommitDraftForWorktree(prev, activeWorktreeId, value)
                )
              }}
              onGenerate={() => {
                void handleGenerate()
              }}
              onCancelGenerate={handleCancelGenerate}
              onPrimaryAction={handlePrimaryClick}
              onDropdownAction={handleActionInvoke}
            />
          )}

          {(scope === 'all' || scope === 'uncommitted') && hasFilteredUncommittedEntries && (
            <>
              {SECTION_ORDER.map((area) => {
                const items = filteredGrouped[area]
                if (items.length === 0) {
                  return null
                }
                const isCollapsed = collapsedSections.has(area)
                // Why: "Stage all"/"Unstage all" operate on the *unfiltered*
                // group for the area — acting on just the filter-visible subset
                // would surprise users who don't realize a filter is active.
                // The +/- is hidden when the filter is active to avoid that
                // mismatch between what's shown and what would be staged.
                // Why: visibility and execution both resolve paths through the
                // same helpers (`getStageAllPaths`/`getUnstageAllPaths`/
                // `getDiscardAllPaths`) so the button can never show for a set
                // the handler would then filter to empty.
                const stageAllPaths =
                  area === 'unstaged' || area === 'untracked'
                    ? getStageAllPaths(grouped[area], area)
                    : []
                const canStageAll = !normalizedFilter && stageAllPaths.length > 0
                const canUnstageAll =
                  !normalizedFilter &&
                  area === 'staged' &&
                  getUnstageAllPaths(grouped.staged).length > 0
                const canRevertAll =
                  !normalizedFilter && getDiscardAllPaths(grouped[area], area).length > 0
                return (
                  <div key={area}>
                    <SectionHeader
                      label={SECTION_LABELS[area]}
                      count={items.length}
                      conflictCount={
                        items.filter((entry) => entry.conflictStatus === 'unresolved').length
                      }
                      isCollapsed={isCollapsed}
                      onToggle={() => toggleSection(area)}
                      actions={
                        <>
                          {/* Why: bulk action buttons are hover-only on
                              pointer devices to avoid cluttering the section
                              header with persistent icons. On no-hover
                              pointers (touch, and SSH sessions where hover
                              state is unreliable — see AGENTS.md "SSH Use
                              Case"), force them visible so they're reachable
                              without tabbing. One outer wrapper so that
                              focusing any action reveals all three siblings —
                              otherwise keyboard users tab into an invisible
                              next stop. */}
                          <div className="flex items-center opacity-0 transition-opacity group-hover/section:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100">
                            {canRevertAll && (
                              <ActionButton
                                icon={area === 'untracked' ? Trash : Undo2}
                                // Why: for untracked files, discard deletes the file
                                // outright (rm -rf via git.discard's untracked branch).
                                // A generic "Discard all" label hides that severity —
                                // label explicitly for the destructive variant.
                                title={
                                  area === 'untracked' ? 'Delete all untracked' : 'Discard all'
                                }
                                onClick={(event) => {
                                  event.stopPropagation()
                                  requestDiscardAllInArea(area)
                                }}
                                disabled={isExecutingBulk}
                              />
                            )}
                            {canStageAll && (
                              <ActionButton
                                icon={Plus}
                                title="Stage all"
                                onClick={(event) => {
                                  event.stopPropagation()
                                  if (area === 'unstaged' || area === 'untracked') {
                                    void handleStageAllInArea(area)
                                  }
                                }}
                                disabled={isExecutingBulk}
                              />
                            )}
                            {canUnstageAll && (
                              <ActionButton
                                icon={Minus}
                                title="Unstage all"
                                onClick={(event) => {
                                  event.stopPropagation()
                                  void handleUnstageAll()
                                }}
                                disabled={isExecutingBulk}
                              />
                            )}
                          </div>
                          {items.some((entry) => entry.conflictStatus === 'unresolved') ? (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-6 px-1.5 text-[10px] text-muted-foreground hover:text-foreground"
                              onClick={(e) => {
                                e.stopPropagation()
                                if (activeWorktreeId && worktreePath) {
                                  openAllDiffs(activeWorktreeId, worktreePath, undefined, area)
                                }
                              }}
                            >
                              View all
                            </Button>
                          ) : (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-auto px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground"
                              onClick={(e) => {
                                e.stopPropagation()
                                if (activeWorktreeId && worktreePath) {
                                  openAllDiffs(activeWorktreeId, worktreePath, undefined, area)
                                }
                              }}
                            >
                              View all
                            </Button>
                          )}
                        </>
                      }
                    />
                    {!isCollapsed &&
                      items.map((entry) => {
                        const key = `${entry.area}::${entry.path}`
                        return (
                          <UncommittedEntryRow
                            key={key}
                            entryKey={key}
                            entry={entry}
                            currentWorktreeId={currentWorktreeId}
                            worktreePath={worktreePath}
                            selected={selectedKeySet.has(key)}
                            onSelect={handleSelect}
                            onContextMenu={handleContextMenu}
                            onRevealInExplorer={revealInExplorer}
                            onOpen={handleOpenDiff}
                            onStage={handleStage}
                            onUnstage={handleUnstage}
                            onDiscard={requestDiscardEntry}
                            commentCount={diffCommentCountByPath.get(entry.path) ?? 0}
                          />
                        )
                      })}
                  </div>
                )
              })}
            </>
          )}

          {scope === 'all' &&
          branchSummary &&
          branchSummary.status !== 'ready' &&
          branchSummary.status !== 'loading' ? (
            <CompareUnavailable
              summary={branchSummary}
              onChangeBaseRef={() => setBaseRefDialogOpen(true)}
              onRetry={() => void refreshBranchCompare()}
            />
          ) : null}

          {scope === 'all' && branchSummary?.status === 'ready' && hasFilteredBranchEntries && (
            <div>
              <SectionHeader
                label="Committed on Branch"
                count={filteredBranchEntries.length}
                isCollapsed={collapsedSections.has('branch')}
                onToggle={() => toggleSection('branch')}
                actions={
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-auto px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground"
                    onClick={(e) => {
                      e.stopPropagation()
                      if (activeWorktreeId && worktreePath && branchSummary) {
                        openBranchAllDiffs(activeWorktreeId, worktreePath, branchSummary)
                      }
                    }}
                  >
                    View all
                  </Button>
                }
              />
              {!collapsedSections.has('branch') &&
                filteredBranchEntries.map((entry) => (
                  <BranchEntryRow
                    key={`branch:${entry.path}`}
                    entry={entry}
                    currentWorktreeId={currentWorktreeId}
                    worktreePath={worktreePath}
                    onRevealInExplorer={revealInExplorer}
                    onOpen={() => openCommittedDiff(entry)}
                    commentCount={diffCommentCountByPath.get(entry.path) ?? 0}
                  />
                ))}
            </div>
          )}
        </div>

        {selectedKeys.size > 0 && (
          <BulkActionBar
            selectedCount={selectedKeys.size}
            stageableCount={bulkStagePaths.length}
            unstageableCount={bulkUnstagePaths.length}
            onStage={handleBulkStage}
            onUnstage={handleBulkUnstage}
            onClear={clearSelection}
            isExecuting={isExecutingBulk}
          />
        )}
      </div>

      <Dialog
        open={pendingDiscard !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPendingDiscard(null)
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-sm">
              {pendingDiscardCopy?.title ?? 'Discard changes?'}
            </DialogTitle>
            <DialogDescription className="text-xs">
              {pendingDiscardCopy?.description ?? 'This cannot be undone.'}
            </DialogDescription>
          </DialogHeader>
          {pendingDiscard?.kind === 'area' ? (
            <div className="rounded-md border border-border/70 bg-muted/35 px-3 py-2 text-xs text-muted-foreground">
              {pendingDiscard.paths.length} {pendingDiscard.paths.length === 1 ? 'file' : 'files'}
            </div>
          ) : pendingDiscard?.kind === 'entry' ? (
            <div className="rounded-md border border-border/70 bg-muted/35 px-3 py-2 text-xs">
              <div className="break-all font-medium text-foreground">
                {pendingDiscard.entry.path}
              </div>
            </div>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setPendingDiscard(null)}>
              Cancel
            </Button>
            <Button type="button" variant="destructive" onClick={confirmPendingDiscard}>
              <PendingDiscardIcon className="size-4" />
              {pendingDiscardCopy?.confirmLabel ?? 'Discard'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={baseRefDialogOpen} onOpenChange={setBaseRefDialogOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle className="text-sm">Change Base Ref</DialogTitle>
            <DialogDescription className="text-xs">
              Pick the branch compare target for this repository.
            </DialogDescription>
          </DialogHeader>
          <BaseRefPicker
            repoId={activeRepo.id}
            currentBaseRef={activeRepo.worktreeBaseRef}
            onSelect={(ref) => {
              void updateRepo(activeRepo.id, { worktreeBaseRef: ref })
              setBaseRefDialogOpen(false)
              window.setTimeout(() => void refreshBranchCompare(), 0)
            }}
            onUsePrimary={() => {
              void updateRepo(activeRepo.id, { worktreeBaseRef: undefined })
              setBaseRefDialogOpen(false)
              window.setTimeout(() => void refreshBranchCompare(), 0)
            }}
          />
        </DialogContent>
      </Dialog>
    </>
  )
}

const SourceControl = React.memo(SourceControlInner)
export default SourceControl

type CommitAreaProps = {
  commitMessage: string
  commitError: string | null
  isCommitting: boolean
  aiEnabled: boolean
  aiAgentConfigured: boolean
  isGenerating: boolean
  generateError: string | null
  stagedCount: number
  hasUnresolvedConflicts: boolean
  isRemoteOperationActive: boolean
  inFlightRemoteOpKind: RemoteOpKind | null
  primaryAction: PrimaryAction
  dropdownItems: DropdownEntry[]
  onCommitMessageChange: (message: string) => void
  onGenerate: () => void
  onCancelGenerate: () => void
  onPrimaryAction: () => void
  onDropdownAction: (kind: DropdownActionKind) => void
}

export function CommitArea({
  commitMessage,
  commitError,
  isCommitting,
  aiEnabled,
  aiAgentConfigured,
  isGenerating,
  generateError,
  stagedCount,
  hasUnresolvedConflicts,
  isRemoteOperationActive,
  inFlightRemoteOpKind,
  primaryAction,
  dropdownItems,
  onCommitMessageChange,
  onGenerate,
  onCancelGenerate,
  onPrimaryAction,
  onDropdownAction
}: CommitAreaProps): React.JSX.Element {
  // Why: cap at 12 rows so a pasted multi-page commit message doesn't push
  // the Commit button off-screen. The textarea keeps `resize-none` (matching
  // the existing style) — the browser scrolls internally past 12 rows.
  const rows = Math.min(12, Math.max(2, commitMessage.split('\n').length))
  // Why: only spin the primary when its label matches what's actually
  // running. resolvePrimaryAction overrides the primary kind to mirror the
  // in-flight op (e.g. user picks Sync from the dropdown → primary becomes
  // "Sync"), so the equality check spins the button for any primary-
  // eligible remote op the user triggered. Background ops the primary
  // doesn't show (Fetch) leave primaryAction.kind unchanged and the
  // mismatch keeps the spinner off — the disabled state alone is enough
  // signal there. Commit still spins on isCommitting because that path
  // doesn't go through inFlightRemoteOpKind.
  const showSpinner =
    primaryAction.kind === 'commit'
      ? isCommitting
      : isRemoteOperationActive && primaryAction.kind === inFlightRemoteOpKind
  // Why: when the primary doesn't host the in-flight op (e.g. Fetch, or any
  // dropdown action that mismatches the primary's natural label) the click
  // would otherwise be silent — the toast only fires on failure and a
  // no-op fetch leaves status counts unchanged. Spinning the chevron gives
  // the user immediate feedback that the action they picked is running,
  // while still leaving the menu reachable to read the disabled-row
  // tooltips.
  const showChevronSpinner = (isCommitting || isRemoteOperationActive) && !showSpinner

  // Why: most primary-kind labels are anchored by a directional icon so
  // the affirmative Commit (✓) reads distinctly from the remote-state
  // labels sharing this slot — Push (↑), Sync (↕), Publish (☁︎↑). Pull is
  // intentionally icon-less because the down-arrow read as a
  // download/save affordance. The icon is decorative; the label and
  // title attribute carry the meaning for assistive tech.
  const PrimaryIcon = PRIMARY_ICONS[primaryAction.kind]

  const hasMessage = commitMessage.trim().length > 0

  // Why: only render the Generate button when the user has opted into the
  // feature. Mounting a perma-disabled button would leak space and add noise
  // for users who never plan to use AI commit messages.
  const showGenerate = aiEnabled
  let generateDisabledReason: string | undefined
  if (isGenerating) {
    generateDisabledReason = 'Generating commit message…'
  } else if (isCommitting) {
    generateDisabledReason = 'Commit in progress…'
  } else if (!aiAgentConfigured) {
    generateDisabledReason = 'Pick an agent in Settings → AI Commit Messages.'
  } else if (stagedCount === 0) {
    generateDisabledReason = 'Stage at least one file to generate a message.'
  } else if (hasMessage) {
    generateDisabledReason = 'Clear the message to regenerate.'
  }
  const isGenerateDisabled =
    !aiAgentConfigured ||
    isGenerating ||
    isCommitting ||
    stagedCount === 0 ||
    hasMessage ||
    hasUnresolvedConflicts

  return (
    <div className="px-3 pb-2">
      <div className="relative">
        <textarea
          rows={rows}
          value={commitMessage}
          onChange={(e) => onCommitMessageChange(e.target.value)}
          placeholder="Message"
          aria-label="Commit message"
          aria-describedby={
            commitError
              ? 'commit-area-error'
              : generateError
                ? 'commit-area-generate-error'
                : undefined
          }
          // Why: reserve right padding so typed text does not slide under the
          // absolute-positioned Generate icon in the top-right corner.
          className={`mt-0.5 w-full resize-none rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground outline-none placeholder:text-muted-foreground/70 focus-visible:ring-1 focus-visible:ring-ring ${
            showGenerate ? 'pr-7' : ''
          }`}
        />
        {showGenerate &&
          (isGenerating ? (
            // Why: while generating the icon doubles as the cancel affordance.
            // Default state shows the spinning RefreshCw; on hover/focus we
            // swap to a Square ("stop") with a destructive tint so the user
            // sees that clicking will abort the run. Group/group-hover toggles
            // keep this stateless on the React side.
            <button
              type="button"
              onClick={() => onCancelGenerate()}
              title="Stop generating"
              aria-label="Stop generating commit message"
              className="group absolute right-1.5 top-1.5 inline-flex size-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:bg-destructive/10 focus-visible:text-destructive focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-destructive/40"
            >
              <RefreshCw className="size-3.5 animate-spin group-hover:hidden group-focus-visible:hidden" />
              <Square className="hidden size-3.5 fill-current group-hover:block group-focus-visible:block" />
            </button>
          ) : (
            <button
              type="button"
              disabled={isGenerateDisabled}
              onClick={() => onGenerate()}
              title={generateDisabledReason ?? 'Generate commit message with AI'}
              aria-label="Generate commit message with AI"
              className="absolute right-1.5 top-1.5 inline-flex size-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
            >
              <Sparkles className="size-3.5" />
            </button>
          ))}
      </div>
      {/* Why: primary + chevron sit together as a visual split button so the
          edit → commit → push loop stays in a single vertical band. The
          chevron exposes the full action surface (fetch, pull, sync,
          publish, compound commits) without forcing morphing labels to
          carry every possible intent. */}
      <div className="mt-1 flex items-stretch">
        {/* Why: match the "Squash and merge" button in PRActions
            (size="xs", px-3 text-[11px]) so the sidebar has a consistent
            action-button shape across Source Control and Checks. The primary
            and chevron share a single rounded rectangle — rounded-r-none on
            the primary and rounded-l-none + border-l on the chevron make the
            pair read as one split button instead of two detached buttons. */}
        <Button
          type="button"
          size="xs"
          disabled={primaryAction.disabled}
          onClick={() => onPrimaryAction()}
          className="flex-1 rounded-r-none px-3 text-[11px]"
          title={primaryAction.title}
        >
          {showSpinner ? (
            <RefreshCw className="size-3.5 animate-spin" />
          ) : PrimaryIcon ? (
            <PrimaryIcon className="size-3.5" aria-hidden="true" />
          ) : null}
          {primaryAction.label}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              size="xs"
              className={cn(
                'rounded-l-none border-l border-primary-foreground/20 px-1.5 shrink-0',
                // Why: mirror the primary's disabled dimming so the split
                // button reads as one unit when Commit is unavailable. The
                // chevron itself stays clickable — its dropdown exposes
                // independently-gated remote actions (push / fetch / pull)
                // that are still valid when the primary is disabled.
                primaryAction.disabled && 'opacity-50'
              )}
              aria-label="More commit and remote actions"
              title="More actions"
            >
              {showChevronSpinner ? (
                <RefreshCw className="size-3.5 animate-spin" />
              ) : (
                <ChevronDown className="size-3.5" />
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[14rem]">
            {dropdownItems.map((entry, index) =>
              entry.kind === 'separator' ? (
                <DropdownMenuSeparator key={`sep-${index}`} />
              ) : (
                <DropdownMenuItem
                  key={entry.kind}
                  disabled={entry.disabled}
                  title={entry.title}
                  onSelect={(event) => {
                    if (entry.disabled) {
                      event.preventDefault()
                      return
                    }
                    onDropdownAction(entry.kind)
                  }}
                >
                  {entry.label}
                </DropdownMenuItem>
              )
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {commitError && (
        // Why: role="alert" + aria-live="polite" lets screen readers announce
        // commit failures; the id ties the message to the textarea via
        // aria-describedby so assistive tech associates the two.
        <p
          id="commit-area-error"
          role="alert"
          aria-live="polite"
          className="mt-1 text-[11px] text-destructive"
        >
          {commitError}
        </p>
      )}
      {generateError && (
        <p
          id="commit-area-generate-error"
          role="alert"
          aria-live="polite"
          className="mt-1 text-[11px] text-destructive"
        >
          {generateError}
        </p>
      )}
    </div>
  )
}

function CompareSummary({
  summary,
  onChangeBaseRef,
  onRetry
}: {
  summary: GitBranchCompareSummary | null
  onChangeBaseRef: () => void
  onRetry: () => void
}): React.JSX.Element {
  if (!summary || summary.status === 'loading') {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <RefreshCw className="size-3.5 animate-spin" />
        <span>Comparing against {summary?.baseRef ?? '…'}</span>
      </div>
    )
  }

  if (summary.status !== 'ready') {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="truncate">{summary.errorMessage ?? 'Branch compare unavailable'}</span>
        <button
          className="shrink-0 hover:text-foreground"
          onClick={onChangeBaseRef}
          title="Change base ref"
        >
          <Settings2 className="size-3.5" />
        </button>
        <button className="shrink-0 hover:text-foreground" onClick={onRetry} title="Retry">
          <RefreshCw className="size-3.5" />
        </button>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      {summary.commitsAhead !== undefined && (
        <span title={`Comparing against ${summary.baseRef}`}>
          {summary.commitsAhead} commits ahead
        </span>
      )}
      <TooltipProvider delayDuration={400}>
        <div className="ml-auto flex items-center gap-2 shrink-0">
          <Tooltip>
            <TooltipTrigger asChild>
              <button className="hover:text-foreground p-0.5 rounded" onClick={onChangeBaseRef}>
                <Settings2 className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              Change base ref
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button className="hover:text-foreground p-0.5 rounded" onClick={onRetry}>
                <RefreshCw className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              Refresh branch compare
            </TooltipContent>
          </Tooltip>
        </div>
      </TooltipProvider>
    </div>
  )
}

function CompareUnavailable({
  summary,
  onChangeBaseRef,
  onRetry
}: {
  summary: GitBranchCompareSummary
  onChangeBaseRef: () => void
  onRetry: () => void
}): React.JSX.Element {
  const changeBaseRefAllowed =
    summary.status === 'invalid-base' ||
    summary.status === 'no-merge-base' ||
    summary.status === 'error'

  return (
    <div className="m-3 rounded-md border border-border/60 bg-muted/20 px-3 py-3 text-xs">
      <div className="font-medium text-foreground">
        {summary.status === 'error' ? 'Branch compare failed' : 'Branch compare unavailable'}
      </div>
      <div className="mt-1 text-muted-foreground">
        {summary.errorMessage ?? 'Unable to load branch compare.'}
      </div>
      <div className="mt-3 flex items-center gap-2">
        {changeBaseRefAllowed && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={onChangeBaseRef}
          >
            <Settings2 className="size-3.5" />
            Change Base Ref
          </Button>
        )}
        <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={onRetry}>
          <RefreshCw className="size-3.5" />
          Retry
        </Button>
      </div>
    </div>
  )
}

function SectionHeader({
  label,
  count,
  conflictCount = 0,
  isCollapsed,
  onToggle,
  actions
}: {
  label: string
  count: number
  conflictCount?: number
  isCollapsed: boolean
  onToggle: () => void
  actions?: React.ReactNode
}): React.JSX.Element {
  // Why: wrap the toggle button and actions in a shared rounded container
  // so the hover background spans the entire row instead of clipping around
  // the label. The outer div keeps the vertical spacing that separates
  // sections; the inner wrapper owns the hover rectangle.
  return (
    <div className="pl-1 pr-3 pt-3 pb-1">
      <div className="group/section flex items-center rounded-md pr-1 hover:bg-accent hover:text-accent-foreground">
        <button
          type="button"
          className="flex flex-1 items-center gap-1 px-0.5 py-0.5 text-left text-xs font-semibold uppercase tracking-wider text-foreground/70 group-hover/section:text-accent-foreground"
          onClick={onToggle}
        >
          <ChevronDown
            className={cn('size-3.5 shrink-0 transition-transform', isCollapsed && '-rotate-90')}
          />
          <span>{label}</span>
          <span className="text-[11px] font-medium tabular-nums">{count}</span>
          {conflictCount > 0 && (
            <span className="text-[11px] font-medium text-destructive/80">
              · {conflictCount} conflict{conflictCount === 1 ? '' : 's'}
            </span>
          )}
        </button>
        <div className="shrink-0 flex items-center">{actions}</div>
      </div>
    </div>
  )
}

function DiffCommentsInlineList({
  comments,
  onDelete,
  onOpen
}: {
  comments: DiffComment[]
  onDelete: (commentId: string) => void
  // Why: clicking the note row navigates the user to that file's diff (or
  // editor as a fallback) and, when a `commentId` is supplied, scrolls the
  // diff to that specific note via the scrollToDiffCommentId UI slice.
  onOpen: (filePath: string, commentId?: string) => void
}): React.JSX.Element {
  // Why: group by filePath so the inline list mirrors the structure in the
  // Notes tab — a compact section per file with line-number prefixes.
  const groups = useMemo(() => {
    const map = new Map<string, DiffComment[]>()
    for (const c of comments) {
      const list = map.get(c.filePath) ?? []
      list.push(c)
      map.set(c.filePath, list)
    }
    for (const list of map.values()) {
      list.sort((a, b) => a.lineNumber - b.lineNumber)
    }
    return Array.from(map.entries())
  }, [comments])

  const [copiedId, setCopiedId] = useState<string | null>(null)

  // Why: auto-dismiss the per-row "copied" indicator so the button returns to
  // its default icon after a brief confirmation window. Matches the top-level
  // Copy button's behavior.
  useEffect(() => {
    if (!copiedId) {
      return
    }
    const handle = window.setTimeout(() => setCopiedId(null), 1500)
    return () => window.clearTimeout(handle)
  }, [copiedId])

  const handleCopyOne = useCallback(async (c: DiffComment): Promise<void> => {
    try {
      await window.api.ui.writeClipboardText(formatDiffComment(c))
      setCopiedId(c.id)
    } catch {
      // Why: swallow — clipboard write can fail when the window isn't focused.
    }
  }, [])

  if (comments.length === 0) {
    return (
      <div className="px-6 py-2 text-[11px] text-muted-foreground">
        Hover over a line in the diff view and click the + to add a note.
      </div>
    )
  }

  return (
    <div className="bg-muted/20">
      {groups.map(([filePath, list]) => (
        <div key={filePath} className="px-3 py-1.5">
          <button
            type="button"
            className="block w-full truncate text-left text-[10px] font-medium text-muted-foreground hover:text-foreground"
            onClick={() => onOpen(filePath)}
            title={`Open ${filePath}`}
          >
            {filePath}
          </button>
          <ul className="mt-1 space-y-1">
            {list.map((c) => (
              <li
                key={c.id}
                className="group flex items-center gap-1.5 rounded px-1 py-0.5 hover:bg-accent/40"
              >
                <button
                  type="button"
                  // Why: a single inner button is the click/keyboard target so
                  // the row's action buttons (copy/delete) can stay as
                  // siblings without nesting interactive elements — that
                  // pattern violates ARIA's no-interactive-descendants rule
                  // for buttons and lets bubbled key events from the children
                  // fire the row's open handler.
                  className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded text-left"
                  onClick={() => onOpen(c.filePath, c.id)}
                  title={`Open ${c.filePath} (line ${c.lineNumber})`}
                  aria-label={`Open note on line ${c.lineNumber}`}
                >
                  <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[10px] leading-none tabular-nums text-muted-foreground">
                    L{c.lineNumber}
                  </span>
                  <span className="block min-w-0 flex-1 whitespace-pre-wrap break-words text-[11px] leading-snug text-foreground">
                    {c.body}
                  </span>
                </button>
                <button
                  type="button"
                  className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
                  onClick={() => void handleCopyOne(c)}
                  title="Copy note"
                  aria-label={`Copy note on line ${c.lineNumber}`}
                >
                  {copiedId === c.id ? <Check className="size-3" /> : <Copy className="size-3" />}
                </button>
                <button
                  type="button"
                  className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                  onClick={() => onDelete(c.id)}
                  title="Delete note"
                  aria-label={`Delete note on line ${c.lineNumber}`}
                >
                  <Trash className="size-3" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}

function ConflictSummaryCard({
  conflictOperation,
  unresolvedCount,
  onReview
}: {
  conflictOperation: GitConflictOperation
  unresolvedCount: number
  onReview: () => void
}): React.JSX.Element {
  const operationLabel =
    conflictOperation === 'merge'
      ? 'Merge conflicts'
      : conflictOperation === 'rebase'
        ? 'Rebase conflicts'
        : conflictOperation === 'cherry-pick'
          ? 'Cherry-pick conflicts'
          : 'Conflicts'

  return (
    <div className="rounded-md border border-amber-500/25 bg-amber-500/5 px-3 py-2">
      <div className="flex items-start gap-2">
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <div className="min-w-0 flex-1">
          <div
            className="text-xs font-medium text-foreground"
            aria-live="polite"
          >{`${operationLabel}: ${unresolvedCount} unresolved`}</div>
          <div className="mt-1 text-[11px] text-muted-foreground">
            Resolved files move back to normal changes after they leave the live conflict state.
          </div>
        </div>
      </div>
      <div className="mt-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 text-xs w-full"
          onClick={onReview}
        >
          <GitMerge className="size-3.5" />
          Review conflicts
        </Button>
      </div>
    </div>
  )
}

// Why: this banner is separate from ConflictSummaryCard because a rebase (or
// merge/cherry-pick) can be in progress without any conflicts — e.g. between
// rebase steps, or after resolving all conflicts but before --continue. The
// user needs to see the operation state so they know the worktree is mid-rebase
// and that they should run `git rebase --continue` or `--abort`.
function OperationBanner({
  conflictOperation
}: {
  conflictOperation: GitConflictOperation
}): React.JSX.Element {
  const label =
    conflictOperation === 'merge'
      ? 'Merge in progress'
      : conflictOperation === 'rebase'
        ? 'Rebase in progress'
        : conflictOperation === 'cherry-pick'
          ? 'Cherry-pick in progress'
          : 'Operation in progress'

  const Icon = conflictOperation === 'rebase' ? GitPullRequestArrow : GitMerge

  return (
    <div className="rounded-md border border-amber-500/25 bg-amber-500/5 px-3 py-2">
      <div className="flex items-center gap-2">
        <Icon className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <span className="text-xs font-medium text-foreground">{label}</span>
      </div>
    </div>
  )
}

const UncommittedEntryRow = React.memo(function UncommittedEntryRow({
  entryKey,
  entry,
  currentWorktreeId,
  worktreePath,
  selected,
  onSelect,
  onContextMenu,
  onRevealInExplorer,
  onOpen,
  onStage,
  onUnstage,
  onDiscard,
  commentCount
}: {
  entryKey: string
  entry: GitStatusEntry
  currentWorktreeId: string
  worktreePath: string
  selected?: boolean
  onSelect?: (e: React.MouseEvent, key: string, entry: GitStatusEntry) => void
  onContextMenu?: (key: string) => void
  onRevealInExplorer: (worktreeId: string, absolutePath: string) => void
  onOpen: (entry: GitStatusEntry) => void
  onStage: (filePath: string) => Promise<void>
  onUnstage: (filePath: string) => Promise<void>
  onDiscard: (entry: GitStatusEntry) => void
  commentCount: number
}): React.JSX.Element {
  const StatusIcon = STATUS_ICONS[entry.status] ?? FileQuestion
  const fileName = basename(entry.path)
  const parentDir = dirname(entry.path)
  const dirPath = parentDir === '.' ? '' : parentDir
  const isUnresolvedConflict = entry.conflictStatus === 'unresolved'
  const isResolvedLocally = entry.conflictStatus === 'resolved_locally'
  const conflictLabel = entry.conflictKind ? CONFLICT_KIND_LABELS[entry.conflictKind] : null
  // Why: the hint text ("Open and edit…", "Decide whether to…") was removed
  // from the sidebar because it's not actionable here — the user can only
  // click the row, and the conflict-kind label alone is sufficient context.
  // Why: Stage is suppressed for unresolved conflicts because `git add` would
  // immediately erase the `u` record — the only live conflict signal in the
  // sidebar — before the user has actually reviewed the file. The user should
  // resolve in the editor first, then stage from the post-resolution state.
  //
  // Discard is hidden for both unresolved AND resolved_locally rows in v1.
  // For unresolved: discarding is too easy to misfire on a high-risk file.
  // For resolved_locally: discarding can silently re-create the conflict or
  // lose the resolution, and v1 does not have UX to explain this clearly.
  const canDiscard =
    !isUnresolvedConflict &&
    !isResolvedLocally &&
    (entry.area === 'unstaged' || entry.area === 'untracked')
  const canStage =
    !isUnresolvedConflict && (entry.area === 'unstaged' || entry.area === 'untracked')
  const canUnstage = entry.area === 'staged'

  return (
    <SourceControlEntryContextMenu
      currentWorktreeId={currentWorktreeId}
      absolutePath={joinPath(worktreePath, entry.path)}
      onRevealInExplorer={onRevealInExplorer}
      onOpenChange={(open) => {
        if (open && onContextMenu) {
          onContextMenu(entryKey)
        }
      }}
    >
      <div
        data-testid="source-control-entry"
        data-source-control-path={entry.path}
        data-source-control-area={entry.area}
        className={cn(
          'group relative flex cursor-pointer items-center gap-1 pl-5 pr-3 py-1 transition-colors hover:bg-accent/40',
          selected && 'bg-accent/60'
        )}
        draggable
        onDragStart={(e) => {
          if (isUnresolvedConflict && entry.status === 'deleted') {
            e.preventDefault()
            return
          }
          const absolutePath = joinPath(worktreePath, entry.path)
          e.dataTransfer.setData('text/x-orca-file-path', absolutePath)
          e.dataTransfer.effectAllowed = 'copy'
        }}
        onClick={(e) => {
          if (onSelect) {
            onSelect(e, entryKey, entry)
          } else {
            onOpen(entry)
          }
        }}
      >
        <StatusIcon className="size-3.5 shrink-0" style={{ color: STATUS_COLORS[entry.status] }} />
        <div className="min-w-0 flex-1 text-xs">
          <span className="min-w-0 block truncate">
            <span className="text-foreground">{fileName}</span>
            {dirPath && <span className="ml-1.5 text-[11px] text-muted-foreground">{dirPath}</span>}
          </span>
          {conflictLabel && (
            <div className="truncate text-[11px] text-muted-foreground">{conflictLabel}</div>
          )}
        </div>
        {commentCount > 0 && (
          // Why: show a small note marker on any row that has diff notes
          // so the user can tell at a glance which files have review notes
          // attached, without opening the Notes tab.
          <span
            className="flex shrink-0 items-center gap-0.5 text-[10px] text-muted-foreground"
            title={`${commentCount} note${commentCount === 1 ? '' : 's'}`}
          >
            <MessageSquare className="size-3" />
            <span className="tabular-nums">{commentCount}</span>
          </span>
        )}
        {entry.conflictStatus ? (
          <ConflictBadge entry={entry} />
        ) : (
          <span
            className="w-4 shrink-0 text-center text-[10px] font-bold"
            style={{ color: STATUS_COLORS[entry.status] }}
          >
            {STATUS_LABELS[entry.status]}
          </span>
        )}
        <div className="absolute right-0 top-0 bottom-0 shrink-0 hidden group-hover:flex items-center gap-1.5 bg-accent pr-3 pl-2">
          {canDiscard && (
            <ActionButton
              icon={entry.area === 'untracked' ? Trash : Undo2}
              title={
                entry.area === 'untracked'
                  ? 'Delete untracked file'
                  : entry.status === 'deleted'
                    ? 'Restore file'
                    : 'Discard changes'
              }
              onClick={(event) => {
                event.stopPropagation()
                onDiscard(entry)
              }}
            />
          )}
          {canStage && (
            <ActionButton
              icon={Plus}
              title="Stage"
              onClick={(event) => {
                event.stopPropagation()
                void onStage(entry.path)
              }}
            />
          )}
          {canUnstage && (
            <ActionButton
              icon={Minus}
              title="Unstage"
              onClick={(event) => {
                event.stopPropagation()
                void onUnstage(entry.path)
              }}
            />
          )}
        </div>
      </div>
    </SourceControlEntryContextMenu>
  )
})

function ConflictBadge({ entry }: { entry: GitStatusEntry }): React.JSX.Element {
  const isUnresolvedConflict = entry.conflictStatus === 'unresolved'
  const label = isUnresolvedConflict ? 'Unresolved' : 'Resolved locally'
  const Icon = isUnresolvedConflict ? TriangleAlert : CircleCheck
  const badge = (
    <span
      role="status"
      aria-label={`${label} conflict${entry.conflictKind ? `, ${CONFLICT_KIND_LABELS[entry.conflictKind]}` : ''}`}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold',
        isUnresolvedConflict
          ? 'bg-destructive/12 text-destructive'
          : 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-400'
      )}
    >
      <Icon className="size-3" />
      <span>{label}</span>
    </span>
  )

  if (isUnresolvedConflict) {
    return badge
  }

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>{badge}</TooltipTrigger>
        <TooltipContent side="left" sideOffset={6}>
          Local session state derived from a conflict you opened here.
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

function BranchEntryRow({
  entry,
  currentWorktreeId,
  worktreePath,
  onRevealInExplorer,
  onOpen,
  commentCount
}: {
  entry: GitBranchChangeEntry
  currentWorktreeId: string
  worktreePath: string
  onRevealInExplorer: (worktreeId: string, absolutePath: string) => void
  onOpen: () => void
  commentCount: number
}): React.JSX.Element {
  const StatusIcon = STATUS_ICONS[entry.status] ?? FileQuestion
  const fileName = basename(entry.path)
  const parentDir = dirname(entry.path)
  const dirPath = parentDir === '.' ? '' : parentDir

  return (
    <SourceControlEntryContextMenu
      currentWorktreeId={currentWorktreeId}
      absolutePath={joinPath(worktreePath, entry.path)}
      onRevealInExplorer={onRevealInExplorer}
    >
      <div
        className="group flex cursor-pointer items-center gap-1 pl-5 pr-3 py-1 transition-colors hover:bg-accent/40"
        draggable
        onDragStart={(e) => {
          const absolutePath = joinPath(worktreePath, entry.path)
          e.dataTransfer.setData('text/x-orca-file-path', absolutePath)
          e.dataTransfer.effectAllowed = 'copy'
        }}
        onClick={onOpen}
      >
        <StatusIcon className="size-3.5 shrink-0" style={{ color: STATUS_COLORS[entry.status] }} />
        <span className="min-w-0 flex-1 truncate text-xs">
          <span className="text-foreground">{fileName}</span>
          {dirPath && <span className="ml-1.5 text-[11px] text-muted-foreground">{dirPath}</span>}
        </span>
        {commentCount > 0 && (
          <span
            className="flex shrink-0 items-center gap-0.5 text-[10px] text-muted-foreground"
            title={`${commentCount} note${commentCount === 1 ? '' : 's'}`}
          >
            <MessageSquare className="size-3" />
            <span className="tabular-nums">{commentCount}</span>
          </span>
        )}
        <span
          className="w-4 shrink-0 text-center text-[10px] font-bold"
          style={{ color: STATUS_COLORS[entry.status] }}
        >
          {STATUS_LABELS[entry.status]}
        </span>
      </div>
    </SourceControlEntryContextMenu>
  )
}

function SourceControlEntryContextMenu({
  currentWorktreeId,
  absolutePath,
  onRevealInExplorer,
  onOpenChange,
  children
}: {
  currentWorktreeId: string
  absolutePath?: string
  onRevealInExplorer: (worktreeId: string, absolutePath: string) => void
  onOpenChange?: (open: boolean) => void
  children: React.ReactNode
}): React.JSX.Element {
  const handleOpenInFileExplorer = useCallback(() => {
    if (!absolutePath) {
      return
    }
    onRevealInExplorer(currentWorktreeId, absolutePath)
  }, [absolutePath, currentWorktreeId, onRevealInExplorer])

  return (
    <ContextMenu onOpenChange={onOpenChange}>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        <ContextMenuItem onSelect={handleOpenInFileExplorer} disabled={!absolutePath}>
          <FolderOpen className="size-3.5" />
          Open in File Explorer
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

function EmptyState({
  heading,
  supportingText
}: {
  heading: string
  supportingText: string
}): React.JSX.Element {
  return (
    <div className="px-4 py-6">
      <div className="text-sm font-medium text-foreground">{heading}</div>
      <div className="mt-1 text-xs text-muted-foreground">{supportingText}</div>
    </div>
  )
}

export function ActionButton({
  icon: Icon,
  title,
  onClick,
  disabled
}: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  onClick: (event: React.MouseEvent) => void
  disabled?: boolean
}): React.JSX.Element {
  // Why: use the Radix Tooltip instead of the native `title` attribute so the
  // label matches the rest of the sidebar chrome (consistent styling, no OS
  // delay quirks, dismissible on pointer leave).
  //
  // Why (no local TooltipProvider): the app root mounts a single
  // TooltipProvider (see App.tsx); nesting another one here gives this subtree
  // its own delay-timing state and breaks Radix's "skip the open delay when
  // moving between adjacent tooltip triggers" handoff between sibling action
  // buttons in the section header.
  //
  // Why (disabled handling): Radix's TooltipTrigger asChild on a disabled
  // <button> gets pointer-events blocked in Chromium, which suppresses the
  // tooltip entirely — a regression vs. the native `title` attribute it
  // replaced. We keep the button interactive and rely on the caller's
  // `isExecutingBulk` early-return to no-op the click during bulk ops;
  // `aria-disabled` + visual dimming preserves the disabled affordance.
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className={cn(
            'h-auto w-auto p-0.5 text-muted-foreground hover:text-foreground',
            disabled && 'opacity-50 cursor-not-allowed'
          )}
          aria-label={title}
          aria-disabled={disabled}
          onClick={(event) => {
            if (disabled) {
              event.preventDefault()
              return
            }
            onClick(event)
          }}
        >
          <Icon className="size-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {title}
      </TooltipContent>
    </Tooltip>
  )
}

function compareGitStatusEntries(a: GitStatusEntry, b: GitStatusEntry): number {
  return (
    getConflictSortRank(a) - getConflictSortRank(b) ||
    a.path.localeCompare(b.path, undefined, { numeric: true })
  )
}

function getConflictSortRank(entry: GitStatusEntry): number {
  if (entry.conflictStatus === 'unresolved') {
    return 0
  }
  if (entry.conflictStatus === 'resolved_locally') {
    return 1
  }
  return 2
}
