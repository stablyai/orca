/* eslint-disable max-lines -- Why: the worktree card centralizes sidebar card state (selection, drag, agent status, git info, context menu) in one cohesive component so sidebar rendering doesn't fan out across files. */
import React, { useEffect, useCallback, useState } from 'react'
import { useAppStore } from '@/store'
import { getHostedReviewCacheKey } from '@/store/slices/hosted-review'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import {
  AlertCircle,
  AlertTriangle,
  ChevronDown,
  GitMerge,
  LoaderCircle,
  Server,
  ServerOff,
  Sparkles,
  Star,
  Trash2,
  Workflow
} from 'lucide-react'
import CacheTimer, { usePromptCacheCountdownStartedAt } from './CacheTimer'
import WorktreeContextMenu from './WorktreeContextMenu'
import { SshDisconnectedDialog } from './SshDisconnectedDialog'
import { AutoRenameFailedDialog } from './AutoRenameFailedDialog'
import WorktreeCardAgents from './WorktreeCardAgents'
import { WorktreeCardStatusSlot } from './WorktreeCardStatusSlot'
import { cn } from '@/lib/utils'
import { activateWorktreeFromSidebar } from '@/lib/sidebar-worktree-activation'
import { getRepoKindLabel, isFolderRepo } from '../../../../shared/repo-kind'
import type { HostedReviewInfo } from '../../../../shared/hosted-review'
import type {
  GitHubWorkItem,
  Worktree,
  Repo,
  IssueInfo,
  LinearIssue
} from '../../../../shared/types'
import { CONFLICT_OPERATION_LABELS } from './WorktreeCardHelpers'
import {
  WorktreeCardDetailsHover,
  hasWorktreeCardDetails,
  WorktreeCardMetaBadges,
  type WorktreeCardIssueDisplay
} from './WorktreeCardMeta'
import { WorktreeCardPortsDetails, WorktreeCardPortsTrigger } from './WorktreeCardPorts'
import { writeWorkspaceDragData } from './workspace-status'
import { getWorktreeCardPrDisplay } from './worktree-card-pr-display'
import { useWorktreeCardDetailsHoverControl } from './worktree-card-details-hover-state'
import { getWorkspacePortsByWorktreeId } from '@/lib/workspace-port-groups'
import { RepoBadgeMark } from '@/components/repo/RepoBadgeLabel'
import { RepoIconGlyph } from '@/components/repo/repo-icon'
import { resolveRepoHeaderColor } from './project-header-color'
import { installWindowVisibilityInterval, isWindowVisible } from '@/lib/window-visibility-interval'
import { isMacAppDataPath } from '@/lib/passive-macos-app-data-access'
import { runWorktreeDelete } from './delete-worktree-flow'
import { WorktreeTitleInlineRename } from './WorktreeTitleInlineRename'
import {
  canShowWorkspaceDeleteQuickAction,
  useWorkspaceDeleteModifierPressed
} from './workspace-delete-quick-action'
import { DetachedHeadBadge } from '@/components/DetachedHeadBadge'
import { getWorktreeGitIdentityDisplay } from '@/lib/worktree-git-identity-display'

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
  inPinnedSection?: boolean
  contentIndent?: number
  flushSurface?: boolean
  lineageChildCount?: number
  lineageCollapsed?: boolean
  lineageChildren?: React.ReactNode
  onLineageToggle?: (event: React.MouseEvent<HTMLButtonElement>) => void
  onActivate?: () => void
  onImmediateActivate?: (worktreeId: string) => void
  onSelectionGesture?: (event: React.MouseEvent<HTMLElement>, worktreeId: string) => boolean
  onContextMenuSelect?: (
    event: React.MouseEvent<HTMLElement>,
    worktree: Worktree
  ) => readonly Worktree[]
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

// Why: the pinned repo icon and the compact inline badge share one chip shell;
// keep the box + tooltip identical so both repo cues read as the same affordance.
function RepoIdentityChip({
  repo,
  children
}: {
  repo: Repo
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="inline-flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-worktree-sidebar-border bg-worktree-sidebar-accent/55"
          aria-label={`Project ${repo.displayName}`}
        >
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>
        {repo.displayName}
      </TooltipContent>
    </Tooltip>
  )
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
  onImmediateActivate,
  onSelectionGesture,
  onContextMenuSelect,
  onCardDragStart,
  onCardDragEnd,
  nativeDragEnabled = true,
  hideRepoBadge,
  inPinnedSection = false,
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
  const renamingWorktreeId = useAppStore((s) => s.renamingWorktreeId)
  const setRenamingWorktreeId = useAppStore((s) => s.setRenamingWorktreeId)
  const fetchHostedReviewForBranch = useAppStore((s) => s.fetchHostedReviewForBranch)
  const settings = useAppStore((s) => s.settings)
  const fetchIssue = useAppStore((s) => s.fetchIssue)
  const fetchLinearIssue = useAppStore((s) => s.fetchLinearIssue)
  const cardProps = useAppStore((s) => s.worktreeCardProperties)
  const compactCards = settings?.compactWorktreeCards === true
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
  const sshDisconnectedPromptKey = isActive && isSshDisconnected ? worktree.id : null
  const [lastSshDisconnectedPromptKey, setLastSshDisconnectedPromptKey] = useState<string | null>(
    null
  )
  const [titleRenaming, setTitleRenaming] = useState(false)
  const [showRenameErrorDialog, setShowRenameErrorDialog] = useState(false)

  // Why: on restart the previously-active worktree is auto-restored without a
  // click, so the dialog never opens. Auto-show it for the active card when SSH
  // is disconnected, but keep dismissals sticky until that prompt key changes.
  if (sshDisconnectedPromptKey !== lastSshDisconnectedPromptKey) {
    setLastSshDisconnectedPromptKey(sshDisconnectedPromptKey)
    if (sshDisconnectedPromptKey) {
      setShowDisconnectedDialog(true)
    }
  }
  // Why: read the target label from the store (populated during hydration in
  // useIpcEvents.ts) instead of calling listTargets IPC per card instance.
  const sshTargetLabel = useAppStore((s) =>
    repo?.connectionId ? (s.sshTargetLabels.get(repo.connectionId) ?? '') : ''
  )

  const gitIdentityDisplay = getWorktreeGitIdentityDisplay(worktree)
  const detachedHeadDisplay = gitIdentityDisplay?.kind === 'detached' ? gitIdentityDisplay : null
  const branch = gitIdentityDisplay?.kind === 'branch' ? gitIdentityDisplay.branchName : ''
  const isFolder = repo ? isFolderRepo(repo) : false
  const hostedReviewCacheKey =
    repo && branch
      ? getHostedReviewCacheKey(repo.path, branch, settings, repo.id, repo.connectionId)
      : ''
  const issueCacheKey = repo && worktree.linkedIssue ? `${repo.id}::${worktree.linkedIssue}` : ''
  // Why: use 'all' to fetch from all Linear workspaces. The issue might belong
  // to a different workspace than the currently selected one.
  const linearIssueCacheKey = worktree.linkedLinearIssue ? `all::${worktree.linkedLinearIssue}` : ''

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
  const linkedGitLabMR = worktree.linkedGitLabMR ?? null
  const prDisplay = getWorktreeCardPrDisplay(hostedReview, worktree.linkedPR, linkedGitLabMR)
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
  const linearStatus = useAppStore((s) => s.linearStatus)
  const linearIssue: LinearIssue | null | undefined = worktree.linkedLinearIssue
    ? (linearIssueEntry?.data ?? linearIssueFallbackEntry?.data)
    : null

  // Why: construct a Linear URL from the organizationUrlKey and identifier
  // when the API hasn't returned the full issue data yet, so the user can
  // still navigate to the issue even while it's loading.
  // Use the issue's workspaceId if available to get the correct organizationUrlKey,
  // otherwise fall back to the currently selected workspace.
  const linearOrgUrlKey = linearStatus?.viewer?.organizationUrlKey
  const linearWorkspaceUrlKeys = linearStatus?.workspaces?.map((ws) => ({
    id: ws.id,
    organizationUrlKey: ws.organizationUrlKey
  }))
  const linearIssueUrlFallback = React.useMemo(() => {
    if (!worktree.linkedLinearIssue || linearIssue?.url) {
      return undefined
    }

    // Try to get the orgUrlKey from the issue's workspace if we have workspaceId
    let orgUrlKey: string | undefined
    if (linearIssue?.workspaceId && linearWorkspaceUrlKeys) {
      const issueWorkspace = linearWorkspaceUrlKeys.find((ws) => ws.id === linearIssue.workspaceId)
      orgUrlKey = issueWorkspace?.organizationUrlKey
    }

    // Fall back to current viewer's org if no workspace match
    if (!orgUrlKey) {
      orgUrlKey = linearOrgUrlKey
    }

    if (!orgUrlKey) {
      return undefined
    }

    return `https://linear.app/${encodeURIComponent(orgUrlKey)}/issue/${encodeURIComponent(worktree.linkedLinearIssue)}`
  }, [
    worktree.linkedLinearIssue,
    linearIssue?.url,
    linearIssue?.workspaceId,
    linearOrgUrlKey,
    linearWorkspaceUrlKeys
  ])

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
              : 'Loading Linear issue...',
          url: linearIssueUrlFallback
        }
    : null
  const isDeleting = deleteState?.isDeleting ?? false
  const deleteModifierPressed = useWorkspaceDeleteModifierPressed()

  const showDetailedCardProperties = !compactCards
  const showIssue = cardProps.includes('issue')
  const showLinearIssue = cardProps.includes('linear-issue')
  const showPR = cardProps.includes('pr')
  const showComment = cardProps.includes('comment')
  const showPorts = cardProps.includes('ports')

  // Skip hosted-review fetches when the corresponding card surfaces are hidden.
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
      // number from explicit metadata whenever we have one.
      void fetchHostedReviewForBranch(repo.path, branch, {
        repoId: repo.id,
        linkedGitHubPR: worktree.linkedPR ?? null,
        linkedGitLabMR,
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
    linkedGitLabMR,
    fetchHostedReviewForBranch,
    branch,
    hostedReviewCacheKey,
    showPR
  ])

  // Same rationale for issues: once that surface is hidden, polling only burns
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
      void fetchLinearIssue(linearIssueId, 'all')
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
      onImmediateActivate?.(worktree.id)
      activateWorktreeFromSidebar(worktree.id)
      if (isSshDisconnected) {
        setShowDisconnectedDialog(true)
      }
      onActivate?.()
    },
    [worktree.id, isSshDisconnected, onActivate, onImmediateActivate, onSelectionGesture]
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
  const handlePendingFirstAgentMessageRenameInfo = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault()
      event.stopPropagation()
    },
    []
  )
  const handleOpenRenameErrorDialog = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.stopPropagation()
    setShowRenameErrorDialog(true)
  }, [])

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

  const handleContextMenuSelect = useCallback(
    (event: React.MouseEvent<HTMLElement>) => onContextMenuSelect?.(event, worktree) ?? [worktree],
    [onContextMenuSelect, worktree]
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
  const detailsHoverControl = useWorktreeCardDetailsHoverControl()
  const hasExplicitLinkedReview =
    (metaReview?.provider === 'github' && worktree.linkedPR !== null) ||
    (metaReview?.provider === 'gitlab' && linkedGitLabMR !== null)
  const handleUnlinkReview = useCallback(() => {
    if (metaReview?.provider === 'gitlab') {
      void updateWorktreeMeta(worktree.id, { linkedGitLabMR: null })
      return
    }
    void updateWorktreeMeta(worktree.id, { linkedPR: null })
  }, [metaReview?.provider, updateWorktreeMeta, worktree.id])
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
  // Why: pinned trees mix repos in one section; a leading repo icon keeps the
  // list scannable, so it shows regardless of groupBy's hideRepoBadge.
  const showPinnedRepoIcon = inPinnedSection && !!repo
  const showInlineRepoBadge =
    compactCards && !!repo && !hideRepoBadge && !isFolder && !showPinnedRepoIcon
  const showRepoBadgeInMetaRow = !compactCards && !!repo && !hideRepoBadge && !showPinnedRepoIcon
  const showDetachedHeadInMetaRow = !compactCards && !isFolder && detachedHeadDisplay !== null
  const showBranch =
    !isFolder && branch.length > 0 && (!compactCards || branch !== worktree.displayName)
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
  // Why: detailed cards need a stable metadata lane only when it has content.
  // Grouped project views can hide the repo badge; don't reserve a blank
  // metadata lane unless branch or detached-head identity has content.
  const hasDetailedMetaRowContent = Boolean(
    (showRepoBadgeInMetaRow && repo) ||
    isFolder ||
    showBranch ||
    showDetachedHeadInMetaRow ||
    showConflictOperationBadge ||
    cacheStartedAt != null ||
    showMetaRowDetails
  )
  const hasMetaRow = compactCards
    ? hasMetadataBadge || cacheStartedAt != null
    : hasDetailedMetaRowContent
  const showHeaderActions = showTitleRowUnread || showTitleRowPrimary || showDeleteQuickAction
  const showBranchIdentityHover = compactCards && showBranch
  const showInlineAgentList = showDetailedCardProperties && cardProps.includes('inline-agents')
  // Why: sidebar rows need a small surface inset, while their content remains
  // aligned with the pre-inset layout and the repo header hierarchy.
  const cardStyle = flushSurface
    ? {
        paddingLeft:
          contentIndent > 0 ? `max(0.125rem, calc(${contentIndent}px - 0.625rem))` : '0.125rem'
      }
    : contentIndent > 0
      ? { paddingLeft: `calc(0.125rem + ${contentIndent}px)` }
      : undefined

  const titleDetailsWrapper =
    compactCards && (showBranchIdentityHover || hasDetails || hasPorts)
      ? (title: React.ReactElement) => (
          <WorktreeCardDetailsHover
            issue={metaIssue}
            linearIssue={metaLinearIssue}
            review={metaReview}
            comment={metaComment}
            branchName={showBranchIdentityHover ? branch : undefined}
            workspaceTitle={worktree.displayName}
            detailsAfter={hasPorts ? <WorktreeCardPortsDetails ports={workspacePorts} /> : null}
            openDelay={100}
            hoverControl={detailsHoverControl}
            onEditIssue={handleEditIssue}
            onEditComment={handleEditComment}
            onOpenGitHubIssueInOrca={
              metaIssue && 'url' in metaIssue && metaIssue.url
                ? handleOpenGitHubIssueInOrca
                : undefined
            }
            onOpenLinearIssueInOrca={linearIssue?.url ? handleOpenLinearIssueInOrca : undefined}
            onOpenReviewInOrca={
              metaReview?.url && metaReview.provider === 'github'
                ? handleOpenReviewInOrca
                : undefined
            }
            // Why: compact mode hides the metadata badge row, so title hover
            // carries the same explicit-link affordance without adding chrome.
            onUnlinkReview={hasExplicitLinkedReview ? handleUnlinkReview : undefined}
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
        hoverControl={detailsHoverControl}
        onEditIssue={handleEditIssue}
        onEditComment={handleEditComment}
        onOpenGitHubIssueInOrca={
          metaIssue && 'url' in metaIssue && metaIssue.url ? handleOpenGitHubIssueInOrca : undefined
        }
        onOpenLinearIssueInOrca={linearIssue?.url ? handleOpenLinearIssueInOrca : undefined}
        onOpenReviewInOrca={
          metaReview?.url && metaReview.provider === 'github' ? handleOpenReviewInOrca : undefined
        }
        // Why: branch lookup can show a review without persisted metadata. Only
        // expose unlink when this workspace has an explicit linked PR/MR.
        onUnlinkReview={hasExplicitLinkedReview ? handleUnlinkReview : undefined}
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
        'group relative flex items-start gap-0.5 pl-0 pr-1.5 pt-1.5 pb-2 cursor-pointer transition-[background-color,border-color,opacity,box-shadow] duration-200 outline-none select-none',
        flushSurface ? 'ml-1 w-[calc(100%-0.25rem)]' : 'ml-1',
        isMultiSelected ? 'rounded-sm' : 'rounded-lg',
        isActiveSurface
          ? 'bg-black/[0.08] shadow-[0_1px_2px_rgba(0,0,0,0.04)] border border-black/[0.015] dark:bg-white/[0.10] dark:border-border/40 dark:shadow-[0_1px_2px_rgba(0,0,0,0.03)]'
          : isMultiSelected
            ? 'border border-worktree-sidebar-ring/35 bg-worktree-sidebar-accent/70 ring-1 ring-worktree-sidebar-ring/30'
            : 'border border-transparent worktree-sidebar-card-hover',
        isActiveSurface && isMultiSelected && 'ring-1 ring-worktree-sidebar-ring/35',
        revealHighlight && [
          'scroll-to-current-workspace-reveal-highlight',
          revealHighlightTone === 'ai' && 'scroll-to-current-workspace-reveal-highlight--ai'
        ],
        titleRenaming && '!border-transparent !bg-transparent !shadow-none !ring-0',
        isDeleting && 'opacity-50 grayscale cursor-not-allowed',
        isSshDisconnected && !isDeleting && 'opacity-60'
      )}
      data-worktree-card-surface="true"
      data-worktree-card-active={isActiveSurface ? 'true' : undefined}
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
      <div
        className={cn(
          'flex min-w-0 flex-1 flex-col gap-1.5',
          // Why: inline agent rows intentionally outdent into the card gutter;
          // title/meta truncation is handled by their own inner elements.
          lineageChildren || showInlineAgentList ? 'overflow-visible' : 'overflow-hidden'
        )}
      >
        {/* Header row: Title */}
        <div className="flex items-center justify-between min-w-0 gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            {showPinnedRepoIcon && (
              <RepoIdentityChip repo={repo}>
                <RepoIconGlyph
                  repoIcon={repo.repoIcon}
                  color={resolveRepoHeaderColor(repo.badgeColor)}
                  className="size-full"
                  iconClassName="size-3"
                />
              </RepoIdentityChip>
            )}

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
              <RepoIdentityChip repo={repo}>
                <RepoBadgeMark color={repo.badgeColor} className="size-2 rounded-[2px]" />
              </RepoIdentityChip>
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
              beginEditing={renamingWorktreeId === worktree.id}
              onBeginEditingConsumed={() => setRenamingWorktreeId(null)}
            />

            {typeof worktree.firstAgentMessageRenameError === 'string' &&
            worktree.firstAgentMessageRenameError.length > 0 &&
            !titleRenaming ? (
              // The auto-rename generation step failed — surface it (red) rather
              // than the silent "rename pending". The full message is raw agent
              // CLI output (often many lines), so the badge opens a dialog on
              // click instead of cramming it into a tooltip.
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    onPointerDown={stopQuickActionPointerPropagation}
                    onClick={handleOpenRenameErrorDialog}
                    onDoubleClick={handleOpenRenameErrorDialog}
                    className="h-4 shrink-0 gap-0.5 rounded !px-0.5 text-[10px] font-medium leading-none text-destructive border border-destructive/40 bg-destructive/10 hover:bg-destructive/15 hover:text-destructive has-[>svg]:!px-0.5"
                    aria-label="Auto-rename failed: view error"
                  >
                    <AlertCircle className="size-2.5" />
                    rename failed
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="right" sideOffset={8}>
                  Auto-name failed. Click to see details.
                </TooltipContent>
              </Tooltip>
            ) : worktree.pendingFirstAgentMessageRename === true && !titleRenaming ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    onPointerDown={stopQuickActionPointerPropagation}
                    onClick={handlePendingFirstAgentMessageRenameInfo}
                    onDoubleClick={handlePendingFirstAgentMessageRenameInfo}
                    className="h-4 shrink-0 gap-0.5 rounded !px-0.5 text-[10px] font-medium leading-none text-muted-foreground border border-worktree-sidebar-border/60 bg-worktree-sidebar-accent/45 hover:bg-worktree-sidebar-accent hover:text-foreground has-[>svg]:!px-0.5"
                    aria-label="Will be renamed from first agent message"
                  >
                    <Sparkles className="size-2.5" />
                    rename pending
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="right" sideOffset={8}>
                  Will be renamed from first agent message
                </TooltipContent>
              </Tooltip>
            ) : null}

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
              ) : showDetachedHeadInMetaRow && detachedHeadDisplay ? (
                <DetachedHeadBadge
                  display={detachedHeadDisplay}
                  label="sidebar"
                  side="right"
                  className="h-[16px]"
                />
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
        {showInlineAgentList && (
          <WorktreeCardAgents
            worktreeId={worktree.id}
            className={hasMetaRow || remoteBranchConflict ? 'mt-0' : '-mt-1'}
          />
        )}

        {showLineageChildChip && (
          <div
            className="relative -ml-1 mt-1 flex min-w-0 justify-start"
            style={{
              color: 'color-mix(in srgb, var(--muted-foreground) 42%, var(--worktree-sidebar))'
            }}
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className="relative z-10 h-[18px] max-w-[8rem] gap-1 rounded-md border border-worktree-sidebar-border bg-worktree-sidebar px-1.5 text-[10px] font-medium leading-none text-muted-foreground shadow-none hover:bg-worktree-sidebar-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-worktree-sidebar-ring"
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

        {lineageChildren && (
          <div className="-ml-[1.125rem] mt-1.5 w-[calc(100%+1.125rem)] space-y-1">
            {lineageChildren}
          </div>
        )}
      </div>
    </div>
  )

  return (
    <>
      <WorktreeContextMenu
        worktree={worktree}
        selectedWorktrees={selectedWorktrees}
        onContextMenuSelect={handleContextMenuSelect}
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

      {typeof worktree.firstAgentMessageRenameError === 'string' &&
        worktree.firstAgentMessageRenameError.length > 0 && (
          <AutoRenameFailedDialog
            open={showRenameErrorDialog}
            onOpenChange={setShowRenameErrorDialog}
            worktreeName={worktree.displayName}
            error={worktree.firstAgentMessageRenameError}
          />
        )}
    </>
  )
})

export default WorktreeCard
