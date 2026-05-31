/* eslint-disable max-lines -- Why: the worktree card centralizes sidebar card state (selection, drag, agent status, git info, context menu) in one cohesive component so sidebar rendering doesn't fan out across files. */
import React, { useEffect, useCallback, useState } from 'react'
import { useAppStore } from '@/store'
import { getHostedReviewCacheKey } from '@/store/slices/hosted-review'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import {
  AlertTriangle,
  ChevronDown,
  GitMerge,
  LoaderCircle,
  Server,
  ServerOff,
  Star,
  Trash2,
  Workflow
} from 'lucide-react'
import CacheTimer, { usePromptCacheCountdownStartedAt } from './CacheTimer'
import WorktreeContextMenu from './WorktreeContextMenu'
import { SshDisconnectedDialog } from './SshDisconnectedDialog'
import WorktreeCardAgents from './WorktreeCardAgents'
import { WorktreeCardStatusSlot } from './WorktreeCardStatusSlot'
import { cn } from '@/lib/utils'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { getRepoKindLabel, isFolderRepo } from '../../../../shared/repo-kind'
import type { HostedReviewInfo } from '../../../../shared/hosted-review'
import type {
  GitHubWorkItem,
  Worktree,
  Repo,
  IssueInfo,
  LinearIssue
} from '../../../../shared/types'
import { branchDisplayName, CONFLICT_OPERATION_LABELS } from './WorktreeCardHelpers'
import {
  WorktreeCardDetailsHover,
  hasWorktreeCardDetails,
  WorktreeCardMetaBadges,
  type WorktreeCardIssueDisplay
} from './WorktreeCardMeta'
import { WorktreeCardPortsDetails, WorktreeCardPortsTrigger } from './WorktreeCardPorts'
import { writeWorkspaceDragData } from './workspace-status'
import { getWorktreeCardPrDisplay } from './worktree-card-pr-display'
import { getWorkspacePortsByWorktreeId } from '@/lib/workspace-port-groups'
import { RepoBadgeMark } from '@/components/repo/RepoBadgeLabel'
import { installWindowVisibilityInterval, isWindowVisible } from '@/lib/window-visibility-interval'
import { isMacAppDataPath } from '@/lib/passive-macos-app-data-access'
import { runWorktreeDelete } from './delete-worktree-flow'
import { WorktreeTitleInlineRename } from './WorktreeTitleInlineRename'
import {
  canShowWorkspaceDeleteQuickAction,
  useWorkspaceDeleteModifierPressed
} from './workspace-delete-quick-action'

type WorktreeCardProps = {
  worktree: Worktree
  repo: Repo | undefined
  isActive: boolean
  isCurrentWorktree?: boolean
  isActiveSurface?: boolean
  isMultiSelected?: boolean
  revealHighlight?: boolean
  revealHighlightTone?: 'default' | 'ai'
  selectedWorktrees?: readonly Worktree[]
  hideRepoBadge?: boolean
  contentIndent?: number
  flushSurface?: boolean
  lineageChildCount?: number
  lineageCollapsed?: boolean
  lineageChildren?: React.ReactNode
  onLineageToggle?: (event: React.MouseEvent<HTMLButtonElement>) => void
  onActivate?: () => void
  onSelectionGesture?: (event: React.MouseEvent<HTMLElement>, worktreeId: string) => boolean
  onContextMenuSelect?: (event: React.MouseEvent<HTMLElement>) => readonly Worktree[]
  onCardDragStart?: (
    event: React.DragEvent<HTMLDivElement>,
    worktreeId: string,
    draggedIds: readonly string[]
  ) => void
  onCardDragEnd?: (event: React.DragEvent<HTMLDivElement>) => void
  nativeDragEnabled?: boolean
}

const EMPTY_WORKSPACE_PORTS = []

function formatSparseDirectoryPreview(directories: string[]): string {
  const preview = directories.slice(0, 4).join(', ')
  return directories.length <= 4 ? preview : `${preview}, +${directories.length - 4} more`
}

function isWebClient(): boolean {
  return Boolean((window as unknown as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__)
}

const WorktreeCard = React.memo(function WorktreeCard({
  worktree,
  repo,
  isActive,
  isActiveSurface = isActive,
  isMultiSelected = false,
  revealHighlight = false,
  revealHighlightTone = 'default',
  selectedWorktrees,
  onActivate,
  onSelectionGesture,
  onContextMenuSelect,
  onCardDragStart,
  onCardDragEnd,
  nativeDragEnabled = true,
  hideRepoBadge,
  contentIndent = 0,
  flushSurface = false,
  lineageChildCount = 0,
  lineageCollapsed = false,
  lineageChildren,
  onLineageToggle
}: WorktreeCardProps) {
  const openModal = useAppStore((s) => s.openModal)
  const openTaskPage = useAppStore((s) => s.openTaskPage)
  const updateWorktreeMeta = useAppStore((s) => s.updateWorktreeMeta)
  const fetchHostedReviewForBranch = useAppStore((s) => s.fetchHostedReviewForBranch)
  const settings = useAppStore((s) => s.settings)
  const fetchIssue = useAppStore((s) => s.fetchIssue)
  const fetchLinearIssue = useAppStore((s) => s.fetchLinearIssue)
  const cardProps = useAppStore((s) => s.worktreeCardProperties)
  const compactCards = settings?.experimentalCompactWorktreeCards === true
  const handleEditIssue = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      openModal('edit-meta', {
        worktreeId: worktree.id,
        currentDisplayName: worktree.displayName,
        currentIssue: worktree.linkedIssue,
        currentPR: worktree.linkedPR,
        currentComment: worktree.comment,
        focus: 'issue'
      })
    },
    [worktree, openModal]
  )

  const handleEditComment = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      openModal('edit-meta', {
        worktreeId: worktree.id,
        currentDisplayName: worktree.displayName,
        currentIssue: worktree.linkedIssue,
        currentPR: worktree.linkedPR,
        currentComment: worktree.comment,
        focus: 'comment'
      })
    },
    [worktree, openModal]
  )

  const deleteState = useAppStore((s) => s.deleteStateByWorktreeId[worktree.id])
  const conflictOperation = useAppStore((s) => s.gitConflictOperationByWorktree[worktree.id])
  const remoteBranchConflict = useAppStore((s) => s.remoteBranchConflictByWorktreeId[worktree.id])
  const workspacePorts = useAppStore(
    (s) =>
      getWorkspacePortsByWorktreeId(s.workspacePortScan?.result).get(worktree.id) ??
      EMPTY_WORKSPACE_PORTS
  )

  // SSH disconnected state
  const sshStatus = useAppStore((s) => {
    if (!repo?.connectionId) {
      return null
    }
    const state = s.sshConnectionStates.get(repo.connectionId)
    return state?.status ?? 'disconnected'
  })
  const isSshDisconnected = sshStatus != null && sshStatus !== 'connected'
  const [showDisconnectedDialog, setShowDisconnectedDialog] = useState(false)
  const [titleRenaming, setTitleRenaming] = useState(false)

  // Why: on restart the previously-active worktree is auto-restored without a
  // click, so the dialog never opens. Auto-show it for the active card when SSH
  // is disconnected so the user sees the reconnect prompt immediately.
  useEffect(() => {
    if (isActive && isSshDisconnected) {
      setShowDisconnectedDialog(true)
    }
  }, [isActive, isSshDisconnected])
  // Why: read the target label from the store (populated during hydration in
  // useIpcEvents.ts) instead of calling listTargets IPC per card instance.
  const sshTargetLabel = useAppStore((s) =>
    repo?.connectionId ? (s.sshTargetLabels.get(repo.connectionId) ?? '') : ''
  )

  const branch = branchDisplayName(worktree.branch)
  const isFolder = repo ? isFolderRepo(repo) : false
  const hostedReviewCacheKey =
    repo && branch
      ? getHostedReviewCacheKey(repo.path, branch, settings, repo.id, repo.connectionId)
      : ''
  const issueCacheKey = repo && worktree.linkedIssue ? `${repo.id}::${worktree.linkedIssue}` : ''
  const linearIssueCacheKey = worktree.linkedLinearIssue
    ? `selected::${worktree.linkedLinearIssue}`
    : ''

  // Subscribe to ONLY the specific cache entry, not entire review/issue caches.
  const hostedReviewEntry = useAppStore((s) =>
    hostedReviewCacheKey ? s.hostedReviewCache[hostedReviewCacheKey] : undefined
  )
  const issueEntry = useAppStore((s) => (issueCacheKey ? s.issueCache[issueCacheKey] : undefined))
  const linearIssueEntry = useAppStore((s) =>
    linearIssueCacheKey ? s.linearIssueCache[linearIssueCacheKey] : undefined
  )
  const linearIssueFallbackEntry = useAppStore((s) =>
    worktree.linkedLinearIssue ? s.linearIssueCache[worktree.linkedLinearIssue] : undefined
  )

  const hostedReview: HostedReviewInfo | null | undefined =
    hostedReviewEntry !== undefined ? hostedReviewEntry.data : undefined
  const fallbackGitHubPRNumber =
    worktree.linkedPR == null && hostedReview?.provider === 'github' ? hostedReview.number : null
  const prDisplay = getWorktreeCardPrDisplay(hostedReview, worktree.linkedPR)
  const issue: IssueInfo | null | undefined = worktree.linkedIssue
    ? issueEntry !== undefined
      ? issueEntry.data
      : undefined
    : null
  const issueDisplay: WorktreeCardIssueDisplay | null =
    issue ??
    (worktree.linkedIssue
      ? {
          number: worktree.linkedIssue,
          // Why: linked metadata is persisted immediately, but GitHub details
          // arrive asynchronously. Show the durable link number instead of
          // making the worktree look unlinked while the cache warms.
          title: issue === null ? 'Issue details unavailable' : 'Loading issue...'
        }
      : null)
  const linearIssue: LinearIssue | null | undefined = worktree.linkedLinearIssue
    ? (linearIssueEntry?.data ?? linearIssueFallbackEntry?.data)
    : null
  const linearIssueDisplay = worktree.linkedLinearIssue
    ? linearIssue
      ? {
          identifier: linearIssue.identifier,
          title: linearIssue.title,
          url: linearIssue.url,
          stateName: linearIssue.state?.name,
          labels: linearIssue.labels
        }
      : {
          identifier: worktree.linkedLinearIssue,
          title:
            linearIssueEntry || linearIssueFallbackEntry
              ? 'Linear issue details unavailable'
              : 'Loading Linear issue...'
        }
    : null
  const isDeleting = deleteState?.isDeleting ?? false
  const deleteModifierPressed = useWorkspaceDeleteModifierPressed()

  const showDetailedCardProperties = !compactCards
  const showPR = showDetailedCardProperties && cardProps.includes('pr')
  const showIssue = showDetailedCardProperties && cardProps.includes('issue')
  const showLinearIssue = showDetailedCardProperties && cardProps.includes('linear-issue')
  const showComment = showDetailedCardProperties && cardProps.includes('comment')
  const showPorts = showDetailedCardProperties && cardProps.includes('ports')

  // Skip hosted-review fetches when the corresponding card sections are hidden.
  // This preference is purely presentational, so background refreshes would
  // spend rate limit budget on data the user cannot see.
  useEffect(() => {
    // Why: paired web should not fan out per-card decoration RPCs during
    // startup; host session/tab parity is the critical path.
    if (isWebClient()) {
      return
    }
    if (
      !repo ||
      isFolder ||
      worktree.isBare ||
      !hostedReviewCacheKey ||
      !showPR ||
      isMacAppDataPath(repo.path)
    ) {
      return
    }
    const refreshHostedReviewIfVisible = (): void => {
      if (!isWindowVisible()) {
        return
      }
      // Why: branch lookup is lossy for fork/deleted-head PRs; reuse a known PR
      // number from metadata or the visible cache whenever we have one.
      void fetchHostedReviewForBranch(repo.path, branch, {
        repoId: repo.id,
        linkedGitHubPR: worktree.linkedPR ?? null,
        fallbackGitHubPR: fallbackGitHubPRNumber,
        linkedGitLabMR: worktree.linkedGitLabMR ?? null,
        staleWhileRevalidate: true
      })
    }
    refreshHostedReviewIfVisible()
    window.addEventListener('focus', refreshHostedReviewIfVisible)
    document.addEventListener('visibilitychange', refreshHostedReviewIfVisible)
    return () => {
      window.removeEventListener('focus', refreshHostedReviewIfVisible)
      document.removeEventListener('visibilitychange', refreshHostedReviewIfVisible)
    }
  }, [
    repo,
    isFolder,
    worktree.isBare,
    worktree.linkedPR,
    fallbackGitHubPRNumber,
    worktree.linkedGitLabMR,
    fetchHostedReviewForBranch,
    branch,
    hostedReviewCacheKey,
    showPR
  ])

  // Same rationale for issues: once that section is hidden, polling only burns
  // GitHub calls and keeps stale-but-invisible data warm for no user benefit.
  useEffect(() => {
    // Why: paired web startup can render hundreds of visible workspace cards.
    // The host is authoritative for repo metadata; issuing decoration lookups
    // from the browser floods the runtime RPC path and delays live surfaces.
    if (
      isWebClient() ||
      !repo ||
      isFolder ||
      !worktree.linkedIssue ||
      !issueCacheKey ||
      !showIssue
    ) {
      return
    }

    const issueNumber = worktree.linkedIssue

    // Background poll as fallback (activity triggers handle the fast path).
    // The interval itself is stopped while hidden so issue cards do not keep
    // long-lived workspaces waking just to skip their fetch.
    return installWindowVisibilityInterval({
      run: () => void fetchIssue(repo.path, issueNumber, { repoId: repo.id }),
      intervalMs: 5 * 60_000
    })
  }, [repo, isFolder, worktree.linkedIssue, fetchIssue, issueCacheKey, showIssue])

  useEffect(() => {
    if (!worktree.linkedLinearIssue || !showLinearIssue) {
      return
    }
    const linearIssueId = worktree.linkedLinearIssue
    const refreshLinearIssueIfVisible = (): void => {
      if (!isWindowVisible()) {
        return
      }
      void fetchLinearIssue(linearIssueId)
    }
    refreshLinearIssueIfVisible()
    window.addEventListener('focus', refreshLinearIssueIfVisible)
    document.addEventListener('visibilitychange', refreshLinearIssueIfVisible)
    return () => {
      window.removeEventListener('focus', refreshLinearIssueIfVisible)
      document.removeEventListener('visibilitychange', refreshLinearIssueIfVisible)
    }
  }, [worktree.linkedLinearIssue, fetchLinearIssue, showLinearIssue])

  // Stable click handler – ignore clicks that are really text selections.
  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const selection = window.getSelection()
      // Why: only suppress the click when the selection is *inside this card*
      // (a real drag-select on the card's own text). A selection anchored
      // elsewhere — e.g. inside the markdown preview while the AI is streaming
      // writes — must not block worktree switching, otherwise the user can't
      // leave the current worktree without first clicking into a terminal to
      // clear the foreign selection.
      if (selection && selection.toString().length > 0) {
        const card = event.currentTarget
        const anchor = selection.anchorNode
        const focus = selection.focusNode
        const selectionInsideCard =
          (anchor instanceof Node && card.contains(anchor)) ||
          (focus instanceof Node && card.contains(focus))
        if (selectionInsideCard) {
          return
        }
      }
      const selectionOnly = onSelectionGesture?.(event, worktree.id) ?? false
      if (selectionOnly) {
        event.preventDefault()
        event.stopPropagation()
        return
      }
      // Why: route sidebar clicks through the shared activation path so the
      // back/forward stack stays complete for the primary worktree navigation
      // surface instead of only recording palette-driven switches.
      activateAndRevealWorktree(worktree.id)
      if (isSshDisconnected) {
        setShowDisconnectedDialog(true)
      }
      onActivate?.()
    },
    [worktree.id, isSshDisconnected, onActivate, onSelectionGesture]
  )

  const handleRenameTitle = useCallback(
    (displayName: string) => updateWorktreeMeta(worktree.id, { displayName }),
    [updateWorktreeMeta, worktree.id]
  )

  const handleDoubleClick = useCallback(() => {
    openModal('edit-meta', {
      worktreeId: worktree.id,
      currentDisplayName: worktree.displayName,
      currentIssue: worktree.linkedIssue,
      currentPR: worktree.linkedPR,
      currentComment: worktree.comment
    })
  }, [
    openModal,
    worktree.comment,
    worktree.displayName,
    worktree.id,
    worktree.linkedIssue,
    worktree.linkedPR
  ])

  const handleToggleUnreadQuick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault()
      event.stopPropagation()
      updateWorktreeMeta(worktree.id, { isUnread: !worktree.isUnread })
    },
    [worktree.id, worktree.isUnread, updateWorktreeMeta]
  )
  // Why: delete is destructive, so it only appears while the user is holding
  // Option/Alt instead of being part of the ordinary hover chrome.
  const showDeleteQuickAction = canShowWorkspaceDeleteQuickAction({
    deleteModifierPressed,
    isDeleting,
    isMainWorktree: worktree.isMainWorktree
  })
  const handleWorkspaceQuickAction = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault()
      event.stopPropagation()
      if (showDeleteQuickAction) {
        runWorktreeDelete(worktree.id)
      }
    },
    [showDeleteQuickAction, worktree.id]
  )

  const unreadTooltip = worktree.isUnread ? 'Mark read' : 'Mark unread'
  const childWorkspaceLabel = `${lineageChildCount} child ${
    lineageChildCount === 1 ? 'workspace' : 'workspaces'
  }`
  const childWorkspaceShortLabel = `${lineageChildCount} ${
    lineageChildCount === 1 ? 'child' : 'children'
  }`
  const showLineageChildChip = lineageChildCount > 0 && onLineageToggle !== undefined

  const handleDragStart = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (isDeleting) {
        event.preventDefault()
        return
      }
      const dragIds =
        isMultiSelected && selectedWorktrees && selectedWorktrees.length > 1
          ? selectedWorktrees.map((item) => item.id)
          : worktree.id
      writeWorkspaceDragData(event.dataTransfer, dragIds)
      onCardDragStart?.(event, worktree.id, Array.isArray(dragIds) ? dragIds : [dragIds])
    },
    [isDeleting, isMultiSelected, onCardDragStart, selectedWorktrees, worktree.id]
  )

  const stopQuickActionPointerPropagation = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      // Why: the Kanban board is dismissed by document-level pointer handling.
      // Quick card actions mutate metadata, but must not count as card activation.
      event.stopPropagation()
    },
    []
  )

  // Why: the 'unread' card property is the user's opt-out. When off, we render
  // as if the workspace is read so bold emphasis never appears. The persisted
  // `worktree.isUnread` flag is unchanged; only the rendering changes.
  const showUnreadEmphasis = cardProps.includes('unread') && worktree.isUnread
  const metaIssue = showIssue ? issueDisplay : null
  const metaLinearIssue = showLinearIssue ? linearIssueDisplay : null
  const metaReview = showPR ? prDisplay : null
  const metaComment = showComment ? worktree.comment : null
  const handleOpenGitHubIssueInOrca = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      const issueUrl = metaIssue && 'url' in metaIssue ? metaIssue.url : undefined
      if (!repo || !metaIssue || !issueUrl) {
        return
      }
      const item: GitHubWorkItem = {
        id: issueUrl,
        type: 'issue',
        number: metaIssue.number,
        title: metaIssue.title,
        state: 'state' in metaIssue ? (metaIssue.state ?? 'open') : 'open',
        url: issueUrl,
        labels: 'labels' in metaIssue ? (metaIssue.labels ?? []) : [],
        updatedAt: new Date().toISOString(),
        author: null,
        repoId: repo.id
      }
      openTaskPage({ taskSource: 'github', preselectedRepoId: repo.id, openGitHubWorkItem: item })
    },
    [metaIssue, openTaskPage, repo]
  )
  const handleOpenReviewInOrca = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      if (!repo || !metaReview?.url || metaReview.provider !== 'github') {
        return
      }
      const item: GitHubWorkItem = {
        id: metaReview.url,
        type: 'pr',
        number: metaReview.number,
        title: metaReview.title,
        state: metaReview.state ?? 'open',
        url: metaReview.url,
        labels: [],
        updatedAt: 'updatedAt' in metaReview ? metaReview.updatedAt : new Date().toISOString(),
        author: null,
        headSha: 'headSha' in metaReview ? metaReview.headSha : undefined,
        repoId: repo.id
      }
      openTaskPage({ taskSource: 'github', preselectedRepoId: repo.id, openGitHubWorkItem: item })
    },
    [metaReview, openTaskPage, repo]
  )
  const handleOpenLinearIssueInOrca = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      if (!linearIssue) {
        return
      }
      openTaskPage({ taskSource: 'linear', openLinearIssue: linearIssue })
    },
    [linearIssue, openTaskPage]
  )
  const hasDetails = hasWorktreeCardDetails({
    issue: metaIssue,
    linearIssue: metaLinearIssue,
    review: metaReview,
    comment: metaComment
  })
  const hasPorts = showPorts && workspacePorts.length > 0
  const cacheStartedAt = usePromptCacheCountdownStartedAt(worktree.id)
  const cacheTtlMs = useAppStore((s) => s.settings?.promptCacheTtlMs ?? 0)
  const showInlineRepoBadge = compactCards && !!repo && !hideRepoBadge && !isFolder
  const showRepoBadgeInMetaRow = !compactCards && !!repo && !hideRepoBadge
  const showBranch = !isFolder && (!compactCards || branch !== worktree.displayName)
  // Why: rebases already surface in source control; keep dense cards from
  // carrying a persistent rebase chip while preserving other interruption cues.
  const showConflictOperationBadge =
    !!conflictOperation && conflictOperation !== 'unknown' && conflictOperation !== 'rebase'
  const hasMetadataBadge = showConflictOperationBadge
  const showStatus = cardProps.includes('status')
  const showUnreadQuickAction = cardProps.includes('unread')
  // Why: the activity dot and unread bell compete for the same tiny sidebar
  // lane. Keep one slot, and let an active unread bell visually win.
  const showCombinedStatusSlot = showStatus || (!compactCards && showUnreadQuickAction)
  const showTitleRowUnread = compactCards && showUnreadQuickAction && !showStatus
  const showTitleRowPrimary = compactCards && worktree.isMainWorktree && !isFolder
  const showMetaRowDetails = !compactCards && (hasDetails || hasPorts)
  // Why: detailed layout is the user's explicit choice to reserve a scannable
  // metadata lane; compact layout only opens that lane for transient state.
  const hasMetaRow = !compactCards || hasMetadataBadge || cacheStartedAt != null
  const showHeaderActions = showTitleRowUnread || showTitleRowPrimary || showDeleteQuickAction
  const showBranchIdentityHover = compactCards && showBranch
  // Why: sidebar rows need a small surface inset, while their content remains
  // aligned with the pre-inset layout and the repo header hierarchy.
  const cardStyle = flushSurface
    ? {
        paddingLeft: contentIndent > 0 ? `calc(${contentIndent}px - 0.125rem)` : '0.125rem'
      }
    : contentIndent > 0
      ? { paddingLeft: `calc(0.125rem + ${contentIndent}px)` }
      : undefined

  const titleDetailsWrapper =
    compactCards && showBranchIdentityHover
      ? (title: React.ReactElement) => (
          <WorktreeCardDetailsHover
            issue={null}
            linearIssue={null}
            review={null}
            comment={null}
            branchName={showBranchIdentityHover ? branch : undefined}
            workspaceTitle={worktree.displayName}
            onEditIssue={handleEditIssue}
            onEditComment={handleEditComment}
          >
            {title}
          </WorktreeCardDetailsHover>
        )
      : undefined

  const detailsAndPorts =
    hasDetails || hasPorts ? (
      <WorktreeCardDetailsHover
        issue={metaIssue}
        linearIssue={metaLinearIssue}
        review={metaReview}
        comment={metaComment}
        detailsAfter={hasPorts ? <WorktreeCardPortsDetails ports={workspacePorts} /> : null}
        onEditIssue={handleEditIssue}
        onEditComment={handleEditComment}
        onOpenGitHubIssueInOrca={
          metaIssue && 'url' in metaIssue && metaIssue.url ? handleOpenGitHubIssueInOrca : undefined
        }
        onOpenLinearIssueInOrca={linearIssue?.url ? handleOpenLinearIssueInOrca : undefined}
        onOpenReviewInOrca={
          metaReview?.url && metaReview.provider === 'github' ? handleOpenReviewInOrca : undefined
        }
      >
        <div className="flex shrink-0 items-center gap-1">
          {hasPorts && <WorktreeCardPortsTrigger ports={workspacePorts} />}
          {hasDetails && (
            <WorktreeCardMetaBadges
              issue={metaIssue}
              linearIssue={metaLinearIssue}
              review={metaReview}
              comment={metaComment}
              className="ml-0 pr-0"
            />
          )}
        </div>
      </WorktreeCardDetailsHover>
    ) : null

  const cardBody = (
    <div
      className={cn(
        'group relative flex items-start gap-1.5 px-1.5 pt-1.5 pb-1 cursor-pointer transition-[background-color,border-color,opacity,box-shadow] duration-200 outline-none select-none',
        flushSurface ? 'ml-1 w-[calc(100%-0.25rem)]' : 'ml-1',
        isMultiSelected ? 'rounded-sm' : 'rounded-lg',
        isActiveSurface
          ? 'bg-black/[0.08] shadow-[0_1px_2px_rgba(0,0,0,0.04)] border border-black/[0.015] dark:bg-white/[0.10] dark:border-border/40 dark:shadow-[0_1px_2px_rgba(0,0,0,0.03)]'
          : isMultiSelected
            ? 'border border-sidebar-ring/35 bg-sidebar-accent/70 ring-1 ring-sidebar-ring/30'
            : 'border border-transparent worktree-sidebar-card-hover',
        isActiveSurface && isMultiSelected && 'ring-1 ring-sidebar-ring/35',
        revealHighlight && [
          'scroll-to-current-workspace-reveal-highlight',
          revealHighlightTone === 'ai' && 'scroll-to-current-workspace-reveal-highlight--ai'
        ],
        titleRenaming && '!border-transparent !bg-transparent !shadow-none !ring-0',
        isDeleting && 'opacity-50 grayscale cursor-not-allowed',
        isSshDisconnected && !isDeleting && 'opacity-60'
      )}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      draggable={nativeDragEnabled && !isDeleting && !titleRenaming}
      onDragStart={nativeDragEnabled ? handleDragStart : undefined}
      onDragEnd={nativeDragEnabled ? onCardDragEnd : undefined}
      aria-busy={isDeleting}
      style={cardStyle}
    >
      {isDeleting && (
        <div className="absolute inset-0 z-10 flex items-center justify-center rounded-lg bg-background/50 backdrop-blur-[1px]">
          <div className="inline-flex items-center gap-1.5 rounded-full bg-background px-3 py-1 text-[11px] font-medium text-foreground shadow-sm border border-border/50">
            <LoaderCircle className="size-3.5 animate-spin text-muted-foreground" />
            Deleting…
          </div>
        </div>
      )}

      {showCombinedStatusSlot ? (
        <div className="flex shrink-0 items-start justify-center pt-[2px]">
          <WorktreeCardStatusSlot
            worktreeId={worktree.id}
            showStatus={showStatus}
            showUnreadAction={showUnreadQuickAction}
            isUnread={worktree.isUnread}
            unreadTooltip={unreadTooltip}
            onPointerDown={stopQuickActionPointerPropagation}
            onToggleUnread={handleToggleUnreadQuick}
          />
        </div>
      ) : null}

      {/* Content area */}
      <div className="flex-1 min-w-0 overflow-hidden flex flex-col gap-1.5">
        {/* Header row: Title */}
        <div className="flex items-center justify-between min-w-0 gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            {repo?.connectionId && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="shrink-0 inline-flex items-center">
                    {isSshDisconnected ? (
                      <ServerOff className="size-3 text-red-400" />
                    ) : (
                      <Server className="size-3 text-muted-foreground" />
                    )}
                  </span>
                </TooltipTrigger>
                <TooltipContent side="right" sideOffset={8}>
                  {isSshDisconnected ? 'SSH disconnected' : 'Remote project via SSH'}
                </TooltipContent>
              </Tooltip>
            )}

            {showInlineRepoBadge && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    className="inline-flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-sidebar-border bg-sidebar-accent/55"
                    aria-label={`Project ${repo.displayName}`}
                  >
                    <RepoBadgeMark color={repo.badgeColor} className="size-2 rounded-[2px]" />
                  </span>
                </TooltipTrigger>
                <TooltipContent side="right" sideOffset={8}>
                  {repo.displayName}
                </TooltipContent>
              </Tooltip>
            )}

            {/* Why: weight alone carries the unread signal; color stays
                 at text-foreground in both states so the title keeps hierarchy
                 against nearby status chips. */}
            <WorktreeTitleInlineRename
              displayName={worktree.displayName}
              disabled={isDeleting}
              showUnreadEmphasis={showUnreadEmphasis}
              className="text-[12px]"
              editingClassName="flex-1"
              titleWrapper={titleDetailsWrapper}
              onEditingChange={setTitleRenaming}
              onRename={handleRenameTitle}
            />

            {!compactCards && worktree.isMainWorktree && !isFolder && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge
                    variant="outline"
                    className="h-[16px] px-1.5 text-[10px] font-medium rounded shrink-0 leading-none text-foreground/70 border-foreground/20 bg-foreground/[0.06]"
                  >
                    primary
                  </Badge>
                </TooltipTrigger>
                <TooltipContent side="right" sideOffset={8}>
                  Primary worktree (original clone directory)
                </TooltipContent>
              </Tooltip>
            )}

            {worktree.isSparse && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge
                    variant="outline"
                    className="h-[16px] px-1.5 text-[10px] font-medium rounded shrink-0 leading-none text-amber-700 dark:text-amber-300 border-amber-500/30 bg-amber-500/5"
                  >
                    sparse
                  </Badge>
                </TooltipTrigger>
                <TooltipContent side="right" sideOffset={8} className="max-w-72">
                  <div className="space-y-1">
                    <div>Partial checkout. Files outside these paths are not on disk.</div>
                    {worktree.sparseDirectories && worktree.sparseDirectories.length > 0 ? (
                      <div className="font-mono text-[11px] opacity-80">
                        {formatSparseDirectoryPreview(worktree.sparseDirectories)}
                      </div>
                    ) : null}
                  </div>
                </TooltipContent>
              </Tooltip>
            )}
          </div>

          {showHeaderActions && (
            <div className="ml-auto flex shrink-0 items-center justify-center gap-1 pr-1.5">
              {showTitleRowUnread && (
                <WorktreeCardStatusSlot
                  worktreeId={worktree.id}
                  showStatus={false}
                  showUnreadAction
                  isUnread={worktree.isUnread}
                  unreadTooltip={unreadTooltip}
                  onPointerDown={stopQuickActionPointerPropagation}
                  onToggleUnread={handleToggleUnreadQuick}
                />
              )}

              {showTitleRowPrimary && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span
                      className="shrink-0 inline-flex items-center"
                      aria-label="Primary worktree"
                    >
                      <Star className="size-3 fill-amber-400 text-amber-400" />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="right" sideOffset={8}>
                    Primary worktree (original clone directory)
                  </TooltipContent>
                </Tooltip>
              )}

              {showDeleteQuickAction && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      data-workspace-board-preserve-open=""
                      onPointerDown={stopQuickActionPointerPropagation}
                      onClick={handleWorkspaceQuickAction}
                      className={cn(
                        'inline-flex size-4 items-center justify-center rounded bg-transparent opacity-0 transition-colors transition-opacity',
                        'group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100',
                        'text-muted-foreground hover:bg-destructive/10 hover:text-destructive focus-visible:bg-destructive/10 focus-visible:text-destructive'
                      )}
                      aria-label="Delete workspace"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="right" sideOffset={8}>
                    Delete workspace
                  </TooltipContent>
                </Tooltip>
              )}
            </div>
          )}
        </div>

        {hasMetaRow && (
          <div className="flex items-center gap-1.5 min-w-0" data-worktree-card-meta-row="">
            <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
              {showRepoBadgeInMetaRow && repo && (
                <div className="flex items-center gap-1.5 shrink-0 px-1.5 py-0.5 rounded-[4px] bg-accent border border-border dark:bg-accent/50 dark:border-border/60">
                  <RepoBadgeMark color={repo.badgeColor} />
                  <span className="text-[10px] font-semibold text-foreground truncate max-w-[6rem] leading-none lowercase">
                    {repo.displayName}
                  </span>
                </div>
              )}

              {isFolder ? (
                <Badge
                  variant="secondary"
                  className="h-[16px] px-1.5 text-[10px] font-medium rounded shrink-0 text-muted-foreground bg-accent border border-border dark:bg-accent/80 dark:border-border/50 leading-none"
                >
                  {repo ? getRepoKindLabel(repo) : 'Folder'}
                </Badge>
              ) : showBranch ? (
                <span className="min-w-0 text-[11px] text-muted-foreground truncate leading-none">
                  {branch}
                </span>
              ) : null}

              {showConflictOperationBadge && (
                <Badge
                  variant="outline"
                  className="h-[16px] px-1.5 text-[10px] font-medium rounded shrink-0 gap-1 text-amber-600 border-amber-500/30 bg-amber-500/5 dark:text-amber-400 dark:border-amber-400/30 dark:bg-amber-400/5 leading-none"
                >
                  <GitMerge className="size-2.5" />
                  {CONFLICT_OPERATION_LABELS[conflictOperation]}
                </Badge>
              )}

              {cacheStartedAt != null && (
                <CacheTimer startedAt={cacheStartedAt} ttlMs={cacheTtlMs} />
              )}
            </div>

            {showMetaRowDetails && (
              <div className="ml-auto flex shrink-0 items-center gap-1 pr-1.5">
                {detailsAndPorts}
              </div>
            )}
          </div>
        )}

        {remoteBranchConflict && (
          <div className="mt-0.5 flex items-start gap-1.5 rounded border border-amber-500/25 bg-amber-500/5 px-1.5 py-1 text-[10.5px] leading-snug text-amber-700 dark:text-amber-300">
            <AlertTriangle className="mt-[1px] size-3 shrink-0" />
            <span className="min-w-0 flex-1">
              {remoteBranchConflict.remote}/{remoteBranchConflict.branchName} already exists.
            </span>
          </div>
        )}

        {/* Why: inline agent list. Gated on the 'inline-agents' card
             property so users can hide it. Layout coupling: this block
             grows the card height dynamically — WorktreeList uses
             measureElement on each row, so the virtualizer re-measures
             naturally when agents appear/disappear. When agents directly
             follow the title, counterbalance the card stack gap so both rows
             read as one compact header group. */}
        {showDetailedCardProperties && cardProps.includes('inline-agents') && (
          <WorktreeCardAgents
            worktreeId={worktree.id}
            className={hasMetaRow || remoteBranchConflict ? 'mt-0' : '-mt-1'}
          />
        )}

        {showLineageChildChip && (
          <div
            className="relative mt-1 flex min-w-0 justify-start"
            style={{ color: 'color-mix(in srgb, var(--muted-foreground) 42%, var(--sidebar))' }}
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className="relative z-10 h-[18px] max-w-[8rem] gap-1 rounded-md border border-sidebar-border bg-sidebar px-1.5 text-[10px] font-medium leading-none text-muted-foreground shadow-none hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-sidebar-ring"
                  aria-label={`${lineageCollapsed ? 'Show' : 'Hide'} ${childWorkspaceLabel}`}
                  aria-expanded={!lineageCollapsed}
                  onClick={onLineageToggle}
                >
                  <Workflow className="size-2.5" />
                  <span className="truncate">{childWorkspaceShortLabel}</span>
                  <ChevronDown
                    className={cn(
                      'size-2.5 transition-transform',
                      lineageCollapsed && '-rotate-90'
                    )}
                  />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right" sideOffset={8}>
                {lineageCollapsed ? 'Show child workspaces' : 'Hide child workspaces'}
              </TooltipContent>
            </Tooltip>
          </div>
        )}

        {lineageChildren && <div className="-ml-3 mt-1.5 space-y-1">{lineageChildren}</div>}
      </div>
    </div>
  )

  return (
    <>
      <WorktreeContextMenu
        worktree={worktree}
        selectedWorktrees={selectedWorktrees}
        onContextMenuSelect={onContextMenuSelect}
      >
        {cardBody}
      </WorktreeContextMenu>

      {repo?.connectionId && (
        <SshDisconnectedDialog
          open={showDisconnectedDialog && isSshDisconnected}
          onOpenChange={setShowDisconnectedDialog}
          targetId={repo.connectionId}
          targetLabel={sshTargetLabel || repo.displayName}
          status={sshStatus ?? 'disconnected'}
        />
      )}
    </>
  )
})

export default WorktreeCard
