/* eslint-disable max-lines -- Why: the worktree card centralizes sidebar card state (selection, drag, agent status, git info, context menu) in one cohesive component so sidebar rendering doesn't fan out across files. */
import React, { useEffect, useCallback, useState } from 'react'
import { useAppStore } from '@/store'
import { getHostedReviewCacheKey } from '@/store/slices/hosted-review'
import { issueCacheKey as getIssueCacheKey } from '@/store/slices/github'
import { getGitHubPRCacheKey } from '@/store/slices/github-cache-key'
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
  Star,
  Trash2,
  Workflow
} from 'lucide-react'
import CacheTimer, { usePromptCacheCountdownStartedAt } from './CacheTimer'
import WorktreeContextMenu from './WorktreeContextMenu'
import { SshDisconnectedDialog } from './SshDisconnectedDialog'
import { AutoRenameFailedDialog } from './AutoRenameFailedDialog'
import { LinearAgentSkillSetupPrompt } from './LinearAgentSkillSetupPrompt'
import WorktreeCardAgents from './WorktreeCardAgents'
import { useWorktreeAgentRows } from './useWorktreeAgentRows'
import { WorktreeCardStatusSlot } from './WorktreeCardStatusSlot'
import { cn } from '@/lib/utils'
import { activateWorktreeFromSidebar } from '@/lib/sidebar-worktree-activation'
import { isFolderRepo } from '../../../../shared/repo-kind'
import type { HostedReviewInfo } from '../../../../shared/hosted-review'
import { hostedReviewInfoFromGitHubPRInfo } from '../../../../shared/hosted-review-github'
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
import {
  getWorktreeCardPrDisplay,
  isCachedMergedBranchPRCurrentForWorktree
} from './worktree-card-pr-display'
import type { WorktreeCardPrDisplay } from './worktree-card-pr-display'
import {
  coerceWorktreeCardVisibleTitle,
  getWorktreeCardTitleDisplay
} from './worktree-card-title-display'
import { useWorktreeCardDetailsHoverControl } from './worktree-card-details-hover-state'
import { isEventTargetInsideCurrentTarget } from './worktree-card-dom-events'
import { getWorkspacePortsByWorktreeId } from '@/lib/workspace-port-groups'
import { RepoBadgeMark } from '@/components/repo/RepoBadgeLabel'
import { RepoIconGlyph } from '@/components/repo/repo-icon'
import { resolveRepoHeaderColor } from './project-header-color'
import { installWindowVisibilityInterval, isWindowVisible } from '@/lib/window-visibility-interval'
import { isMacAppDataPath } from '@/lib/passive-macos-app-data-access'
import { runWorktreeDelete } from './delete-worktree-flow'
import { WorktreeTitleInlineRename } from './WorktreeTitleInlineRename'
import { TruncatedSidebarLabel } from './truncated-sidebar-label'
import {
  canShowWorkspaceDeleteQuickAction,
  useWorkspaceDeleteModifierPressed
} from './workspace-delete-quick-action'
import { DetachedHeadBadge } from '@/components/DetachedHeadBadge'
import { getWorktreeGitIdentityDisplay } from '@/lib/worktree-git-identity-display'
import {
  getFlushWorktreeCardPaddingLeft,
  getNewCardStyleParentContentMarginLeft
} from './worktree-list-indentation'
import { translate } from '@/i18n/i18n'
import { recordRendererCrashBreadcrumb } from '@/lib/crash-diagnostics'
import { folderWorkspaceKey, parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { isRuntimeOwnedSshTargetId, parseExecutionHostId } from '../../../../shared/execution-host'
import { DEFAULT_AGENT_ACTIVITY_DISPLAY_MODE } from '../../../../shared/constants'

type WorktreeRenameRequest = {
  worktreeId: string
  rowKey?: string
}

export type ActiveSurfaceVariant = 'primary' | 'secondary'

type WorktreeCardProps = {
  worktree: Worktree
  repo: Repo | undefined
  isActive: boolean
  isCurrentWorktree?: boolean
  isActiveSurface?: boolean
  activeSurfaceVariant?: ActiveSurfaceVariant
  isMultiSelected?: boolean
  revealHighlight?: boolean
  revealHighlightTone?: 'default' | 'ai'
  selectedWorktrees?: readonly Worktree[]
  hideRepoBadge?: boolean
  hostContextLabel?: string
  inPinnedSection?: boolean
  activationRowKey?: string
  renameRowKey?: string
  contentIndent?: number
  flushSurface?: boolean
  lineageChildCount?: number
  lineageCollapsed?: boolean
  lineageChildren?: React.ReactNode
  lineageChildrenStyle?: React.CSSProperties
  onLineageToggle?: (event: React.MouseEvent<HTMLButtonElement>) => void
  isLineageDropTarget?: boolean
  onActivate?: () => void
  onImmediateActivate?: (worktreeId: string, rowKey: string | undefined) => void
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
  affiliateListMode?: boolean
  statusPrDisplay?: WorktreeCardPrDisplay | null
}

const EMPTY_WORKSPACE_PORTS = []
const HOSTED_REVIEW_CARD_REFRESH_INTERVAL_MS = 60_000

export function shouldBeginWorktreeRename(
  request: WorktreeRenameRequest | null,
  worktreeId: string,
  rowKey: string | undefined
): boolean {
  return (
    request?.worktreeId === worktreeId &&
    (request.rowKey === undefined || request.rowKey === rowKey)
  )
}

function formatSparseDirectoryPreview(directories: string[]): string {
  const preview = directories.slice(0, 4).join(', ')
  return directories.length <= 4 ? preview : `${preview}, +${directories.length - 4} more`
}

function isWebClient(): boolean {
  return Boolean((window as unknown as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__)
}

function getDirectoryName(folderPath: string): string {
  const normalized = folderPath.replace(/[\\/]+$/, '')
  const parts = normalized.split(/[\\/]+/)
  return parts.at(-1) || normalized || folderPath
}

// Why: pinned repo icon and compact inline badge share this chip shell so both repo cues read as the same affordance.
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
          aria-label={translate(
            'auto.components.sidebar.WorktreeCard.35ccfe2475',
            'Project {{value0}}',
            { value0: repo.displayName }
          )}
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
  activeSurfaceVariant = 'primary',
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
  hostContextLabel,
  inPinnedSection = false,
  activationRowKey,
  renameRowKey,
  contentIndent = 0,
  flushSurface = false,
  lineageChildCount = 0,
  lineageCollapsed = false,
  lineageChildren,
  lineageChildrenStyle,
  onLineageToggle,
  isLineageDropTarget = false,
  affiliateListMode = false,
  statusPrDisplay = null
}: WorktreeCardProps) {
  const openModal = useAppStore((s) => s.openModal)
  const openTaskPage = useAppStore((s) => s.openTaskPage)
  const openAutomationsPage = useAppStore((s) => s.openAutomationsPage)
  const setPendingAutomationRunNavigation = useAppStore((s) => s.setPendingAutomationRunNavigation)
  const updateWorktreeMeta = useAppStore((s) => s.updateWorktreeMeta)
  const deleteFolderWorkspace = useAppStore((s) => s.deleteFolderWorkspace)
  const setActiveWorktree = useAppStore((s) => s.setActiveWorktree)
  const renamingWorktreeId = useAppStore((s) => s.renamingWorktreeId)
  const setRenamingWorktreeId = useAppStore((s) => s.setRenamingWorktreeId)
  const fetchHostedReviewForBranch = useAppStore((s) => s.fetchHostedReviewForBranch)
  const settings = useAppStore((s) => s.settings)
  const fetchIssue = useAppStore((s) => s.fetchIssue)
  const fetchLinearIssue = useAppStore((s) => s.fetchLinearIssue)
  const cardProps = useAppStore((s) => s.worktreeCardProperties)
  const agentActivityDisplayMode =
    useAppStore((s) => s.agentActivityDisplayMode) ?? DEFAULT_AGENT_ACTIVITY_DISPLAY_MODE
  const projectGroups = useAppStore((s) => s.projectGroups)
  const newCardStyle = settings?.experimentalNewWorktreeCardStyle === true
  const compactCards = !newCardStyle && settings?.compactWorktreeCards === true
  const activeSurfaceIsSecondary = isActiveSurface && activeSurfaceVariant === 'secondary'
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

  const handleOpenAutomation = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      const automationId = worktree.automationProvenance?.automationId
      if (!automationId) {
        return
      }
      const hostId = worktree.automationProvenance?.hostId ?? worktree.hostId
      setPendingAutomationRunNavigation({
        automationId,
        runId: null,
        ...(hostId ? { hostId } : {})
      })
      openAutomationsPage()
    },
    [
      openAutomationsPage,
      setPendingAutomationRunNavigation,
      worktree.automationProvenance?.automationId,
      worktree.automationProvenance?.hostId,
      worktree.hostId
    ]
  )

  const handleOpenAutomationRun = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      const provenance = worktree.automationProvenance
      if (!provenance) {
        return
      }
      const hostId = provenance.hostId ?? worktree.hostId
      setPendingAutomationRunNavigation({
        automationId: provenance.automationId,
        runId: provenance.automationRunId,
        ...(hostId ? { hostId } : {})
      })
      openAutomationsPage()
    },
    [
      openAutomationsPage,
      setPendingAutomationRunNavigation,
      worktree.automationProvenance,
      worktree.hostId
    ]
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
    // Why: runtime-owned SSH targets suppress their ssh:state-changed broadcasts, so don't show a false "disconnected" chip for them.
    if (!repo?.connectionId || isRuntimeOwnedSshTargetId(repo.connectionId)) {
      return null
    }
    const state = s.sshConnectionStates.get(repo.connectionId)
    return state?.status ?? 'disconnected'
  })
  const isSshDisconnected = sshStatus != null && sshStatus !== 'connected'
  // Why: terminal views have their own reconnect overlay; reserve the blocking dialog for non-terminal views (default to terminal when ambiguous).
  const activeViewIsTerminal = useAppStore(
    (s) => (s.activeTabTypeByWorktree?.[worktree.id] ?? 'terminal') === 'terminal'
  )

  // Why: runtime ("Orca server") hosts get the same disconnected dimming as SSH when their environment has no live status.
  const isRuntimeDisconnected = useAppStore((s) => {
    const parsed = parseExecutionHostId(repo?.executionHostId)
    if (parsed?.kind !== 'runtime') {
      return false
    }
    return !s.runtimeStatusByEnvironmentId.get(parsed.environmentId)?.status
  })
  // Why: the reconnect dialog blocks, so it never auto-shows for the active card (would steal app-wide focus); opens only on deliberate focus (handleClick).
  const [showDisconnectedDialog, setShowDisconnectedDialog] = useState(false)
  const [titleRenaming, setTitleRenaming] = useState(false)
  const [showRenameErrorDialog, setShowRenameErrorDialog] = useState(false)
  // Why: read the target label from the store (hydrated in useIpcEvents.ts) instead of a listTargets IPC per card.
  const sshTargetLabel = useAppStore((s) =>
    repo?.connectionId ? (s.sshTargetLabels.get(repo.connectionId) ?? '') : ''
  )

  const gitIdentityDisplay = getWorktreeGitIdentityDisplay(worktree)
  const detachedHeadDisplay = gitIdentityDisplay?.kind === 'detached' ? gitIdentityDisplay : null
  const branch = gitIdentityDisplay?.kind === 'branch' ? gitIdentityDisplay.branchName : ''
  const workspaceScope = parseWorkspaceKey(worktree.id)
  const folderWorkspaceId =
    workspaceScope?.type === 'folder' ? workspaceScope.folderWorkspaceId : null
  const isFolder = repo ? isFolderRepo(repo) : folderWorkspaceId !== null
  // Why: project groups gate folder workspaces, so folder paths stay hidden from identity surfaces until that capability exists.
  const hasProjectGroups = projectGroups.length > 0
  const branchIdentityDisplay = !isFolder && branch.length > 0 ? branch : undefined
  const folderPathIdentityDisplay =
    isFolder && hasProjectGroups && worktree.path.trim().length > 0 ? worktree.path : undefined
  const identityDisplay = branchIdentityDisplay ?? folderPathIdentityDisplay
  const hasPathIdentityEnabled = cardProps.includes('branch')
  const showIdentityInNewCard = newCardStyle && hasPathIdentityEnabled && Boolean(identityDisplay)
  const folderMetaRowContent = newCardStyle
    ? hasPathIdentityEnabled && Boolean(folderPathIdentityDisplay)
    : isFolder
  const hostedReviewCacheKey =
    repo && branch
      ? getHostedReviewCacheKey(
          repo.path,
          branch,
          settings,
          repo.id,
          repo.connectionId,
          repo.executionHostId,
          true
        )
      : ''
  const prCacheKey =
    repo && branch
      ? getGitHubPRCacheKey(
          repo.path,
          repo.id,
          branch,
          settings,
          repo.connectionId,
          repo.executionHostId,
          true
        )
      : ''
  const issueCacheKey =
    repo && worktree.linkedIssue
      ? getIssueCacheKey(
          repo.path,
          repo.id,
          worktree.linkedIssue,
          settings,
          repo.connectionId,
          repo.executionHostId,
          true
        )
      : ''
  // Why: use 'all' — the issue may belong to a different Linear workspace than the selected one.
  const linearIssueCacheKey = worktree.linkedLinearIssue ? `all::${worktree.linkedLinearIssue}` : ''

  // Subscribe to ONLY the specific cache entry, not entire review/issue caches.
  const hostedReviewEntry = useAppStore((s) =>
    hostedReviewCacheKey ? s.hostedReviewCache[hostedReviewCacheKey] : undefined
  )
  const prCacheEntry = useAppStore((s) => (prCacheKey ? s.prCache?.[prCacheKey] : undefined))
  const issueEntry = useAppStore((s) => (issueCacheKey ? s.issueCache[issueCacheKey] : undefined))
  const linearIssueEntry = useAppStore((s) =>
    linearIssueCacheKey ? s.linearIssueCache[linearIssueCacheKey] : undefined
  )
  const linearIssueFallbackEntry = useAppStore((s) =>
    worktree.linkedLinearIssue ? s.linearIssueCache[worktree.linkedLinearIssue] : undefined
  )

  const hostedReview: HostedReviewInfo | null | undefined =
    hostedReviewEntry !== undefined ? hostedReviewEntry.data : undefined
  const linkedGitHubPR = worktree.linkedPR ?? null
  const linkedGitLabMR = worktree.linkedGitLabMR ?? null
  const linkedBitbucketPR = worktree.linkedBitbucketPR ?? null
  const linkedAzureDevOpsPR = worktree.linkedAzureDevOpsPR ?? null
  const linkedGiteaPR = worktree.linkedGiteaPR ?? null
  const hasNonGitHubLinkedReview =
    linkedGitLabMR !== null ||
    linkedBitbucketPR !== null ||
    linkedAzureDevOpsPR !== null ||
    linkedGiteaPR !== null
  const hasLinkedReview =
    linkedGitHubPR !== null ||
    linkedGitLabMR !== null ||
    linkedBitbucketPR !== null ||
    linkedAzureDevOpsPR !== null ||
    linkedGiteaPR !== null
  // Why: a newer hosted-review miss trusts the merged-PR cache only when the stored head proves it still describes the current commit.
  const cachedBranchPR = prCacheEntry?.data
  const cachedBranchPRFetchedAt = prCacheEntry?.fetchedAt
  const cachedMergedBranchPRMatchesCurrentHead = isCachedMergedBranchPRCurrentForWorktree(
    cachedBranchPR,
    worktree
  )
  const cachedBranchFallbackGitHubPRNumber =
    linkedGitHubPR === null &&
    !hasNonGitHubLinkedReview &&
    cachedBranchPR?.number !== undefined &&
    (cachedBranchPR.state !== 'merged' || cachedMergedBranchPRMatchesCurrentHead)
      ? cachedBranchPR.number
      : null
  const cachedBranchPRCanDriveDisplay =
    cachedBranchPR?.state !== 'merged' || cachedMergedBranchPRMatchesCurrentHead
  const hostedReviewMatchesHeadMatchedCachedMergedPR =
    cachedMergedBranchPRMatchesCurrentHead &&
    cachedBranchPR !== null &&
    cachedBranchPR !== undefined &&
    hostedReview?.provider === 'github' &&
    hostedReview.number === cachedBranchPR.number
  const useCachedBranchReview =
    cachedBranchPR !== undefined &&
    cachedBranchPR !== null &&
    !hasNonGitHubLinkedReview &&
    cachedBranchPRCanDriveDisplay &&
    (hostedReview === undefined ||
      (cachedMergedBranchPRMatchesCurrentHead && !hostedReviewMatchesHeadMatchedCachedMergedPR) ||
      (hostedReview === null &&
        ((cachedBranchPRFetchedAt !== undefined &&
          cachedBranchPRFetchedAt > (hostedReviewEntry?.fetchedAt ?? 0)) ||
          cachedMergedBranchPRMatchesCurrentHead)))
  const cachedBranchReview = useCachedBranchReview
    ? hostedReviewInfoFromGitHubPRInfo(cachedBranchPR)
    : hostedReview
  // Why: branch provenance does not supersede the head-ownership gate for merged PRs.
  const branchLookupGitHubPRNumber =
    hostedReview?.provider === 'github' &&
    hostedReview.state === 'merged' &&
    !isCachedMergedBranchPRCurrentForWorktree(hostedReview, worktree)
      ? null
      : hostedReviewEntry?.branchLookupGitHubPRNumber
  const prDisplay = getWorktreeCardPrDisplay(
    cachedBranchReview,
    linkedGitHubPR,
    linkedGitLabMR,
    linkedBitbucketPR,
    linkedAzureDevOpsPR,
    linkedGiteaPR,
    {
      reviewHintKey:
        (useCachedBranchReview || cachedMergedBranchPRMatchesCurrentHead) && !hasLinkedReview
          ? ''
          : hostedReviewEntry?.linkedReviewHintKey,
      branchLookupGitHubPRNumber
    }
  )
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
          // Why: linked metadata persists immediately but GitHub details arrive async; show the link number so it doesn't look unlinked.
          title: issue === null ? 'Issue details unavailable' : 'Loading issue...'
        }
      : null)
  const linearStatus = useAppStore((s) => s.linearStatus)
  const linearIssue: LinearIssue | null | undefined = worktree.linkedLinearIssue
    ? (linearIssueEntry?.data ?? linearIssueFallbackEntry?.data)
    : null

  // Why: build a fallback Linear URL from org key + identifier while full issue data is still loading, so the link stays navigable.
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
  const cardTitleDisplay = getWorktreeCardTitleDisplay({
    storedDisplayName: worktree.displayName,
    branchName: branch,
    linearIssueTitle: linearIssueDisplay?.title,
    issueTitle: issueDisplay?.title,
    reviewTitle: prDisplay?.title
  })
  const legacyCardTitleDisplay = coerceWorktreeCardVisibleTitle(worktree.displayName)
  const visibleCardTitle = newCardStyle ? cardTitleDisplay : legacyCardTitleDisplay
  const isDeleting = deleteState?.isDeleting ?? false
  const isQueuedForDeletion = deleteState?.phase === 'queued'
  const deleteLabel = isQueuedForDeletion
    ? translate('auto.components.sidebar.WorktreeCard.ef18787206', 'Queued for deletion')
    : translate('auto.components.sidebar.WorktreeCard.691ccfd622', 'Deleting…')
  const deleteModifierPressed = useWorkspaceDeleteModifierPressed()

  const showStatus = cardProps.includes('status')
  const showIssue = cardProps.includes('issue')
  const showLinearIssue = cardProps.includes('linear-issue')
  const showPR = cardProps.includes('pr')
  const showAutomation = cardProps.includes('automation')
  const showComment = cardProps.includes('comment')
  const showPorts = cardProps.includes('ports')
  const shouldRefreshHostedReview = newCardStyle ? showStatus : showPR
  const detailsHoverControl = useWorktreeCardDetailsHoverControl()
  const hoverDetailsOpen = detailsHoverControl.hoverOpen

  // Why: card surfaces are presentational, so skip hosted-review fetches when hidden to save rate-limit budget.
  useEffect(() => {
    // Why: paired web must not fan out per-card decoration RPCs during startup; host session/tab parity is critical.
    if (isWebClient()) {
      return
    }
    if (
      !repo ||
      isFolder ||
      worktree.isBare ||
      !hostedReviewCacheKey ||
      !shouldRefreshHostedReview ||
      isMacAppDataPath(repo.path)
    ) {
      return
    }
    const refreshHostedReview = (): void => {
      // Why: branch lookup is lossy for fork/deleted-head PRs; reuse a known PR number from explicit metadata when we have one.
      void fetchHostedReviewForBranch(repo.path, branch, {
        repoId: repo.id,
        linkedGitHubPR: worktree.linkedPR ?? null,
        ...(cachedBranchFallbackGitHubPRNumber !== null
          ? { fallbackGitHubPR: cachedBranchFallbackGitHubPRNumber }
          : {}),
        currentHeadOid: worktree.head ?? null,
        linkedGitLabMR,
        linkedBitbucketPR,
        linkedAzureDevOpsPR,
        linkedGiteaPR,
        staleWhileRevalidate: true
      })
    }
    // Why: PRs created outside Orca (e.g. `gh pr create`) emit no renderer event; poll visible cards to discover them.
    return installWindowVisibilityInterval({
      run: refreshHostedReview,
      intervalMs: HOSTED_REVIEW_CARD_REFRESH_INTERVAL_MS
    })
  }, [
    repo,
    isFolder,
    worktree.isBare,
    worktree.linkedPR,
    worktree.head,
    cachedBranchFallbackGitHubPRNumber,
    linkedGitLabMR,
    linkedBitbucketPR,
    linkedAzureDevOpsPR,
    linkedGiteaPR,
    fetchHostedReviewForBranch,
    branch,
    hostedReviewCacheKey,
    shouldRefreshHostedReview
  ])

  useEffect(() => {
    if (
      !newCardStyle ||
      !hoverDetailsOpen ||
      shouldRefreshHostedReview ||
      isWebClient() ||
      !repo ||
      isFolder ||
      worktree.isBare ||
      !hostedReviewCacheKey ||
      isMacAppDataPath(repo.path)
    ) {
      return
    }
    // Why: hidden card metadata is revealed on whole-card hover, so fetch lazily instead of always-on polling.
    void fetchHostedReviewForBranch(repo.path, branch, {
      repoId: repo.id,
      linkedGitHubPR: worktree.linkedPR ?? null,
      ...(cachedBranchFallbackGitHubPRNumber !== null
        ? { fallbackGitHubPR: cachedBranchFallbackGitHubPRNumber }
        : {}),
      currentHeadOid: worktree.head ?? null,
      linkedGitLabMR,
      linkedBitbucketPR,
      linkedAzureDevOpsPR,
      linkedGiteaPR,
      staleWhileRevalidate: true
    })
  }, [
    hoverDetailsOpen,
    newCardStyle,
    shouldRefreshHostedReview,
    repo,
    isFolder,
    worktree.isBare,
    worktree.linkedPR,
    worktree.head,
    cachedBranchFallbackGitHubPRNumber,
    linkedGitLabMR,
    linkedBitbucketPR,
    linkedAzureDevOpsPR,
    linkedGiteaPR,
    fetchHostedReviewForBranch,
    branch,
    hostedReviewCacheKey
  ])

  // Why: same as above for issues — hidden-surface polling only burns GitHub calls for invisible data.
  useEffect(() => {
    // Why: per-card decoration lookups from the browser flood the RPC path at paired-web startup; the host is authoritative.
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

    // Why: fallback poll behind activity triggers; stopped while hidden to avoid waking idle workspaces.
    return installWindowVisibilityInterval({
      run: () => void fetchIssue(repo.path, issueNumber, { repoId: repo.id }),
      intervalMs: 5 * 60_000
    })
  }, [repo, isFolder, worktree.linkedIssue, fetchIssue, issueCacheKey, showIssue])

  useEffect(() => {
    if (
      !newCardStyle ||
      !hoverDetailsOpen ||
      showIssue ||
      isWebClient() ||
      !repo ||
      isFolder ||
      !worktree.linkedIssue ||
      !issueCacheKey
    ) {
      return
    }
    void fetchIssue(repo.path, worktree.linkedIssue, { repoId: repo.id })
  }, [
    newCardStyle,
    hoverDetailsOpen,
    showIssue,
    repo,
    isFolder,
    worktree.linkedIssue,
    fetchIssue,
    issueCacheKey
  ])

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

  useEffect(() => {
    if (!newCardStyle || !hoverDetailsOpen || showLinearIssue || !worktree.linkedLinearIssue) {
      return
    }
    void fetchLinearIssue(worktree.linkedLinearIssue, 'all')
  }, [
    newCardStyle,
    hoverDetailsOpen,
    showLinearIssue,
    worktree.linkedLinearIssue,
    fetchLinearIssue
  ])

  // Stable click handler – ignore clicks that are really text selections.
  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (!isEventTargetInsideCurrentTarget(event.currentTarget, event.target)) {
        return
      }
      const selection = window.getSelection()
      // Why: only suppress the click for a selection inside this card; a foreign selection must not block worktree switching.
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
      const selectionOnly = affiliateListMode
        ? false
        : (onSelectionGesture?.(event, worktree.id) ?? false)
      if (selectionOnly) {
        event.preventDefault()
        event.stopPropagation()
        return
      }
      if (isDeleting) {
        event.preventDefault()
        event.stopPropagation()
        return
      }
      // Why: route sidebar clicks through the shared activation path so the back/forward stack stays complete.
      recordRendererCrashBreadcrumb('sidebar_worktree_activate', {
        worktreeId: worktree.id,
        repoId: worktree.repoId,
        wasActive: isActive,
        sshDisconnected: isSshDisconnected
      })
      onImmediateActivate?.(worktree.id, activationRowKey)
      void activateWorktreeFromSidebar(worktree.id)
      // Why: a deliberate card click warrants the blocking reconnect prompt; skip it when a terminal already shows the overlay.
      if (isSshDisconnected && !activeViewIsTerminal) {
        setShowDisconnectedDialog(true)
      }
      onActivate?.()
    },
    [
      affiliateListMode,
      worktree.id,
      worktree.repoId,
      isActive,
      isDeleting,
      activationRowKey,
      isSshDisconnected,
      activeViewIsTerminal,
      onActivate,
      onImmediateActivate,
      onSelectionGesture
    ]
  )

  const handleRenameTitle = useCallback(
    (displayName: string) => updateWorktreeMeta(worktree.id, { displayName }),
    [updateWorktreeMeta, worktree.id]
  )

  const handleDoubleClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (affiliateListMode) {
        return
      }
      if (!isEventTargetInsideCurrentTarget(event.currentTarget, event.target)) {
        return
      }
      openModal('edit-meta', {
        worktreeId: worktree.id,
        currentDisplayName: worktree.displayName,
        currentIssue: worktree.linkedIssue,
        currentPR: worktree.linkedPR,
        currentComment: worktree.comment
      })
    },
    [
      openModal,
      affiliateListMode,
      worktree.comment,
      worktree.displayName,
      worktree.id,
      worktree.linkedIssue,
      worktree.linkedPR
    ]
  )

  const handleToggleUnreadQuick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault()
      event.stopPropagation()
      updateWorktreeMeta(worktree.id, { isUnread: !worktree.isUnread })
    },
    [worktree.id, worktree.isUnread, updateWorktreeMeta]
  )
  // Why: delete is destructive, so it only appears while holding Option/Alt, not in the ordinary hover chrome.
  const showDeleteQuickAction =
    !affiliateListMode &&
    canShowWorkspaceDeleteQuickAction({
      deleteModifierPressed,
      isDeleting,
      isMainWorktree: worktree.isMainWorktree
    })
  const handleWorkspaceQuickAction = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault()
      event.stopPropagation()
      if (showDeleteQuickAction) {
        if (folderWorkspaceId) {
          void deleteFolderWorkspace(folderWorkspaceId).then((deleted) => {
            if (
              deleted &&
              useAppStore.getState().activeWorktreeId === folderWorkspaceKey(folderWorkspaceId)
            ) {
              setActiveWorktree(null)
            }
          })
          return
        }
        runWorktreeDelete(worktree.id)
      }
    },
    [
      deleteFolderWorkspace,
      folderWorkspaceId,
      setActiveWorktree,
      showDeleteQuickAction,
      worktree.id
    ]
  )
  const handleOpenRenameErrorDialog = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.stopPropagation()
    setShowRenameErrorDialog(true)
  }, [])
  const unreadTooltip = worktree.isUnread ? 'Mark read' : 'Mark unread'
  const lineageChildAriaLabel =
    lineageChildCount === 1
      ? lineageCollapsed
        ? translate(
            'auto.components.sidebar.WorktreeList.20bebf9c7f',
            'Show {{value0}} child workspace',
            { value0: lineageChildCount }
          )
        : translate(
            'auto.components.sidebar.WorktreeList.e97297cb75',
            'Hide {{value0}} child workspace',
            { value0: lineageChildCount }
          )
      : lineageCollapsed
        ? translate(
            'auto.components.sidebar.WorktreeList.c1f4a31623',
            'Show {{value0}} child workspaces',
            { value0: lineageChildCount }
          )
        : translate(
            'auto.components.sidebar.WorktreeList.0cd15956d4',
            'Hide {{value0}} child workspaces',
            { value0: lineageChildCount }
          )
  const childWorkspaceShortLabel = `${lineageChildCount} ${
    lineageChildCount === 1
      ? translate('auto.components.sidebar.WorktreeList.0c6ee14f23', 'child')
      : translate('auto.components.sidebar.WorktreeList.045a8aed48', 'children')
  }`
  const showLineageChildChip = lineageChildCount > 0 && onLineageToggle !== undefined

  const handleDragStart = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (!isEventTargetInsideCurrentTarget(event.currentTarget, event.target)) {
        event.preventDefault()
        return
      }
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

  const handleDragEnd = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (!isEventTargetInsideCurrentTarget(event.currentTarget, event.target)) {
        return
      }
      onCardDragEnd?.(event)
    },
    [onCardDragEnd]
  )

  const handleContextMenuSelect = useCallback(
    (event: React.MouseEvent<HTMLElement>) => onContextMenuSelect?.(event, worktree) ?? [worktree],
    [onContextMenuSelect, worktree]
  )

  const stopQuickActionPointerPropagation = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      // Why: document-level pointer handling dismisses the Kanban board; quick actions must not count as card activation.
      event.stopPropagation()
    },
    []
  )

  // Why: unread lives in the left status lane, so the Status toggle owns both the dot/PR slot and unread emphasis.
  const showUnreadEmphasis = showStatus && worktree.isUnread
  const hoverIssue = issueDisplay
  const hoverLinearIssue = linearIssueDisplay
  const hoverReview = prDisplay
  const statusLaneReview = statusPrDisplay ?? hoverReview
  const hoverComment = worktree.comment
  const metaIssue = showIssue ? hoverIssue : null
  const metaLinearIssue = showLinearIssue ? hoverLinearIssue : null
  const metaReview = showPR ? hoverReview : null
  const metaAutomationProvenance = showAutomation ? worktree.automationProvenance : null
  const metaComment = showComment ? hoverComment : null
  const showInlineAgentList = cardProps.includes('inline-agents') && (newCardStyle || !compactCards)
  const compactInlineAgentRows = useWorktreeAgentRows(
    worktree.id,
    showInlineAgentList && agentActivityDisplayMode === 'compact'
  )
  const compactInlineAgentRowsVisible =
    showInlineAgentList &&
    agentActivityDisplayMode === 'compact' &&
    compactInlineAgentRows.length > 0
  const showAggregateCacheTimer = !compactCards && !compactInlineAgentRowsVisible
  const handleOpenGitHubIssueInOrca = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      const issueUrl = hoverIssue && 'url' in hoverIssue ? hoverIssue.url : undefined
      if (!repo || !hoverIssue || !issueUrl) {
        return
      }
      const item: GitHubWorkItem = {
        id: issueUrl,
        type: 'issue',
        number: hoverIssue.number,
        title: hoverIssue.title,
        state: 'state' in hoverIssue ? (hoverIssue.state ?? 'open') : 'open',
        url: issueUrl,
        labels: 'labels' in hoverIssue ? (hoverIssue.labels ?? []) : [],
        updatedAt: new Date().toISOString(),
        author: null,
        repoId: repo.id
      }
      openTaskPage({ taskSource: 'github', preselectedRepoId: repo.id, openGitHubWorkItem: item })
    },
    [hoverIssue, openTaskPage, repo]
  )
  const handleOpenReviewInOrca = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      if (!repo || !hoverReview?.url || hoverReview.provider !== 'github') {
        return
      }
      const item: GitHubWorkItem = {
        id: hoverReview.url,
        type: 'pr',
        number: hoverReview.number,
        title: hoverReview.title,
        state: hoverReview.state ?? 'open',
        url: hoverReview.url,
        labels: [],
        updatedAt: 'updatedAt' in hoverReview ? hoverReview.updatedAt : new Date().toISOString(),
        author: null,
        headSha: 'headSha' in hoverReview ? hoverReview.headSha : undefined,
        repoId: repo.id
      }
      openTaskPage({ taskSource: 'github', preselectedRepoId: repo.id, openGitHubWorkItem: item })
    },
    [hoverReview, openTaskPage, repo]
  )
  const hasExplicitLinkedReview =
    (hoverReview?.provider === 'github' && worktree.linkedPR !== null) ||
    (hoverReview?.provider === 'gitlab' && linkedGitLabMR !== null) ||
    (hoverReview?.provider === 'bitbucket' && linkedBitbucketPR !== null) ||
    (hoverReview?.provider === 'azure-devops' && linkedAzureDevOpsPR !== null) ||
    (hoverReview?.provider === 'gitea' && linkedGiteaPR !== null)
  const handleUnlinkReview = useCallback(() => {
    switch (hoverReview?.provider) {
      case 'github':
        void updateWorktreeMeta(worktree.id, { linkedPR: null })
        return
      case 'gitlab':
        void updateWorktreeMeta(worktree.id, { linkedGitLabMR: null })
        return
      case 'bitbucket':
        void updateWorktreeMeta(worktree.id, { linkedBitbucketPR: null })
        return
      case 'azure-devops':
        void updateWorktreeMeta(worktree.id, { linkedAzureDevOpsPR: null })
        return
      case 'gitea':
        void updateWorktreeMeta(worktree.id, { linkedGiteaPR: null })
        return
      case 'unsupported':
      case undefined:
        break
    }
  }, [hoverReview?.provider, updateWorktreeMeta, worktree.id])
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
    review: newCardStyle ? null : metaReview,
    comment: metaComment,
    automationProvenance: metaAutomationProvenance
  })
  const hasPorts = showPorts && workspacePorts.length > 0
  const cacheStartedAt = usePromptCacheCountdownStartedAt(worktree.id, showAggregateCacheTimer)
  const cacheTtlMs = useAppStore((s) =>
    showAggregateCacheTimer ? (s.settings?.promptCacheTtlMs ?? 0) : 0
  )
  // Why: pinned trees mix repos, so the repo icon shows regardless of groupBy's hideRepoBadge.
  const showPinnedRepoIcon = inPinnedSection && !!repo
  // Why: new card style retired the Compact/Detailed switch; repo identity uses the compact chip, not a lower pill.
  const showRepoIdentityInTitle = newCardStyle || compactCards
  const showInlineRepoBadge =
    showRepoIdentityInTitle && !!repo && !hideRepoBadge && !isFolder && !showPinnedRepoIcon
  const showRepoBadgeInMetaRow =
    !showRepoIdentityInTitle && !!repo && !hideRepoBadge && !showPinnedRepoIcon
  const showHostContextBadge = !compactCards && !!hostContextLabel
  const showDetachedHeadInMetaRow = !compactCards && !isFolder && detachedHeadDisplay !== null
  const showBranch =
    !isFolder &&
    branch.length > 0 &&
    !newCardStyle &&
    (!compactCards || branch !== worktree.displayName)
  // Why: rebases already surface in source control, so dense cards skip the persistent rebase chip.
  const showConflictOperationBadge =
    !!conflictOperation && conflictOperation !== 'unknown' && conflictOperation !== 'rebase'
  const hasMetadataBadge = showConflictOperationBadge
  const showUnreadQuickAction = !affiliateListMode && showStatus && !newCardStyle
  // Why: the slot owns the unread/status lane; legacy keeps the bell toggle, the new card keeps the glyph passive.
  const showCombinedStatusSlot = showStatus
  const showTitleRowPrimary = compactCards && worktree.isMainWorktree && !isFolder
  const showMetaRowDetails = !newCardStyle && !compactCards && (hasDetails || hasPorts)
  const showTitleRowIndicators = (newCardStyle || compactCards) && (hasDetails || hasPorts)
  // Why: grouped views can hide the repo badge; don't reserve a blank metadata lane unless there's real content.
  const hasDetailedMetaRowContent = Boolean(
    (showRepoBadgeInMetaRow && repo) ||
    showHostContextBadge ||
    folderMetaRowContent ||
    showBranch ||
    showIdentityInNewCard ||
    showDetachedHeadInMetaRow ||
    showConflictOperationBadge ||
    cacheStartedAt != null ||
    showMetaRowDetails
  )
  const hasMetaRow = compactCards
    ? hasMetadataBadge || cacheStartedAt != null
    : hasDetailedMetaRowContent
  const showHeaderActions = showTitleRowPrimary || showDeleteQuickAction
  // Why: normalize the title once so title/branch de-dupe and identity-only hover eligibility stay in sync.
  const trimmedVisibleCardTitle = visibleCardTitle.trim()
  const showBranchIdentityHover = newCardStyle
    ? Boolean(identityDisplay) &&
      !cardProps.includes('branch') &&
      identityDisplay !== trimmedVisibleCardTitle
    : compactCards && showBranch
  const hoverBranchName = newCardStyle
    ? identityDisplay
    : showBranchIdentityHover
      ? branch
      : undefined
  const hoverWorkspaceTitle =
    trimmedVisibleCardTitle.length > 0 && trimmedVisibleCardTitle !== hoverBranchName
      ? trimmedVisibleCardTitle
      : undefined
  const hasHoverIdentity = Boolean(hoverWorkspaceTitle || hoverBranchName)
  const hasHoverDetails =
    newCardStyle &&
    (hasWorktreeCardDetails({
      issue: hoverIssue,
      linearIssue: hoverLinearIssue,
      review: hoverReview,
      comment: hoverComment,
      automationProvenance: metaAutomationProvenance
    }) ||
      workspacePorts.length > 0 ||
      hasHoverIdentity)
  // Why: the parent row owns metadata hover; don't stack the title's truncation tooltip on the details popover.
  const titleWrapper = newCardStyle
    ? hasHoverDetails
      ? (title: React.ReactElement): React.ReactElement => title
      : undefined
    : compactCards && (showBranchIdentityHover || hasDetails || hasPorts)
      ? (title: React.ReactElement): React.ReactElement => (
          <WorktreeCardDetailsHover
            issue={metaIssue}
            linearIssue={metaLinearIssue}
            review={metaReview}
            comment={metaComment}
            automationProvenance={metaAutomationProvenance}
            automationHostId={worktree.hostId}
            branchName={showBranchIdentityHover ? branch : undefined}
            workspaceTitle={worktree.displayName}
            identityOrder="branch-first"
            detailsAfter={hasPorts ? <WorktreeCardPortsDetails ports={workspacePorts} /> : null}
            openDelay={100}
            // Why: compact mode also renders the plug/badge hover root; sharing one open-state made hovering the
            // plug force-open the wider title card and race it closed (#9304), so let this title hover own its state.
            onEditIssue={affiliateListMode ? undefined : handleEditIssue}
            onEditComment={affiliateListMode ? undefined : handleEditComment}
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
            onOpenAutomation={affiliateListMode ? undefined : handleOpenAutomation}
            onOpenAutomationRun={affiliateListMode ? undefined : handleOpenAutomationRun}
            // Why: compact mode hides the metadata badge row, so title hover carries the explicit-link affordance.
            onUnlinkReview={
              !affiliateListMode && hasExplicitLinkedReview ? handleUnlinkReview : undefined
            }
          >
            {title}
          </WorktreeCardDetailsHover>
        )
      : undefined
  // Why: sidebar rows need a small surface inset while content stays aligned with the pre-inset layout.
  const applyNewCardStyleStatusLaneOffset = newCardStyle && showCombinedStatusSlot
  const cardPaddingLeft = flushSurface
    ? getFlushWorktreeCardPaddingLeft(contentIndent, applyNewCardStyleStatusLaneOffset)
    : contentIndent > 0
      ? `calc(0.125rem + ${contentIndent}px)`
      : null
  const parentContentMarginLeft =
    flushSurface && applyNewCardStyleStatusLaneOffset
      ? getNewCardStyleParentContentMarginLeft(contentIndent)
      : 0
  const cardStyle = cardPaddingLeft ? { paddingLeft: cardPaddingLeft } : undefined
  const detailsAndPortsContent =
    hasDetails || hasPorts ? (
      <div className="flex shrink-0 items-center gap-1">
        {hasPorts && <WorktreeCardPortsTrigger ports={workspacePorts} />}
        {hasDetails && (
          <WorktreeCardMetaBadges
            issue={metaIssue}
            linearIssue={metaLinearIssue}
            review={newCardStyle ? null : metaReview}
            comment={metaComment}
            automationProvenance={metaAutomationProvenance}
            className="ml-0 pr-0"
          />
        )}
      </div>
    ) : null
  const detailsAndPorts =
    detailsAndPortsContent && !newCardStyle ? (
      <WorktreeCardDetailsHover
        issue={metaIssue}
        linearIssue={metaLinearIssue}
        review={metaReview}
        comment={metaComment}
        automationProvenance={metaAutomationProvenance}
        automationHostId={worktree.hostId}
        detailsAfter={hasPorts ? <WorktreeCardPortsDetails ports={workspacePorts} /> : null}
        hoverControl={detailsHoverControl}
        onEditIssue={affiliateListMode ? undefined : handleEditIssue}
        onEditComment={affiliateListMode ? undefined : handleEditComment}
        onOpenGitHubIssueInOrca={
          metaIssue && 'url' in metaIssue && metaIssue.url ? handleOpenGitHubIssueInOrca : undefined
        }
        onOpenLinearIssueInOrca={linearIssue?.url ? handleOpenLinearIssueInOrca : undefined}
        onOpenReviewInOrca={
          metaReview?.url && metaReview.provider === 'github' ? handleOpenReviewInOrca : undefined
        }
        onOpenAutomation={affiliateListMode ? undefined : handleOpenAutomation}
        onOpenAutomationRun={affiliateListMode ? undefined : handleOpenAutomationRun}
        // Why: branch lookup can surface a review without persisted metadata; only unlink when explicitly linked.
        onUnlinkReview={
          !affiliateListMode && hasExplicitLinkedReview ? handleUnlinkReview : undefined
        }
      >
        {detailsAndPortsContent}
      </WorktreeCardDetailsHover>
    ) : (
      detailsAndPortsContent
    )
  const titleRowIndicators = showTitleRowIndicators ? (
    <div className="ml-auto flex shrink-0 items-center gap-1 pr-1.5">{detailsAndPorts}</div>
  ) : null
  const hasSecondaryCardContent =
    hasMetaRow || !!remoteBranchConflict || showInlineAgentList || showLineageChildChip
  const titleOnlyCard = !hasSecondaryCardContent

  const parentCardContent = (
    <div
      className={cn(
        'flex w-full min-w-0 gap-0.5 pl-0',
        titleOnlyCard ? 'items-center' : 'items-start'
      )}
      style={
        parentContentMarginLeft < 0 ? { marginLeft: `${parentContentMarginLeft}px` } : undefined
      }
      data-worktree-card-parent-content=""
    >
      {showCombinedStatusSlot ? (
        <div
          className={cn(
            'flex shrink-0 justify-center',
            newCardStyle ? 'mr-1 w-5 items-center' : 'items-start pt-[2px]',
            affiliateListMode && 'px-1'
          )}
          data-worktree-card-status-slot=""
        >
          <WorktreeCardStatusSlot
            worktreeId={worktree.id}
            showStatus={showStatus}
            showUnreadAction={showUnreadQuickAction}
            isUnread={worktree.isUnread}
            unreadTooltip={unreadTooltip}
            onPointerDown={stopQuickActionPointerPropagation}
            onToggleUnread={handleToggleUnreadQuick}
            prDisplay={statusLaneReview}
            newCardStyle={newCardStyle}
            hasBranchIdentity={Boolean(branchIdentityDisplay)}
          />
        </div>
      ) : null}

      {/* Content area */}
      <div
        className={cn(
          'flex min-w-0 flex-1 flex-col gap-1.5',
          // Why: inline agent rows intentionally outdent into the card gutter; inner elements handle truncation.
          showInlineAgentList || (!newCardStyle && lineageChildren)
            ? 'overflow-visible'
            : 'overflow-hidden'
        )}
      >
        {/* Header row: Title */}
        <div className="flex min-w-0 items-center justify-between gap-2">
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
                  {isSshDisconnected
                    ? translate(
                        'auto.components.sidebar.WorktreeCard.021538e1d1',
                        'SSH disconnected'
                      )
                    : translate(
                        'auto.components.sidebar.WorktreeCard.ca74db7550',
                        'Project on SSH host'
                      )}
                </TooltipContent>
              </Tooltip>
            )}

            {!repo?.connectionId &&
              parseExecutionHostId(repo?.executionHostId)?.kind === 'runtime' && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="shrink-0 inline-flex items-center">
                      {isRuntimeDisconnected ? (
                        <ServerOff className="size-3 text-red-400" />
                      ) : (
                        <Server className="size-3 text-muted-foreground" />
                      )}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="right" sideOffset={8}>
                    {isRuntimeDisconnected
                      ? translate(
                          'auto.components.sidebar.WorktreeCard.runtimeHostDisconnected',
                          'Server disconnected'
                        )
                      : translate(
                          'auto.components.sidebar.WorktreeCard.runtimeHostProject',
                          'Project on Orca server'
                        )}
                  </TooltipContent>
                </Tooltip>
              )}

            {showInlineRepoBadge && (
              <RepoIdentityChip repo={repo}>
                <RepoIconGlyph
                  repoIcon={repo.repoIcon}
                  color={resolveRepoHeaderColor(repo.badgeColor)}
                  className="size-full"
                  iconClassName="size-3"
                />
              </RepoIdentityChip>
            )}

            {/* Why: unread alert lives in the left status lane; title-row contrast comes from weight and dimmed read titles. */}
            <WorktreeTitleInlineRename
              displayName={visibleCardTitle}
              disabled={isDeleting || affiliateListMode}
              showUnreadEmphasis={showUnreadEmphasis}
              dimReadTitle={newCardStyle}
              className="text-[13px] leading-5"
              editingClassName="flex-1"
              titleWrapper={titleWrapper}
              onEditingChange={affiliateListMode ? undefined : setTitleRenaming}
              onRename={handleRenameTitle}
              beginEditing={
                !affiliateListMode &&
                shouldBeginWorktreeRename(renamingWorktreeId, worktree.id, renameRowKey)
              }
              onBeginEditingConsumed={
                affiliateListMode ? undefined : () => setRenamingWorktreeId(null)
              }
            />

            {typeof worktree.firstAgentMessageRenameError === 'string' &&
            worktree.firstAgentMessageRenameError.length > 0 &&
            !titleRenaming ? (
              // Why: the error can be raw agent CLI output, so the badge opens a dialog rather than a tooltip.
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    onPointerDown={stopQuickActionPointerPropagation}
                    onClick={handleOpenRenameErrorDialog}
                    onDoubleClick={handleOpenRenameErrorDialog}
                    className="h-4 shrink-0 gap-0.5 rounded !px-0.5 text-[10px] font-medium leading-none text-destructive border border-destructive/40 bg-destructive/10 hover:bg-destructive/15 hover:text-destructive has-[>svg]:!px-0.5"
                    aria-label={translate(
                      'auto.components.sidebar.WorktreeCard.02e19349f4',
                      'Auto-rename failed: view error'
                    )}
                  >
                    <AlertCircle className="size-2.5" />
                    {translate('auto.components.sidebar.WorktreeCard.74522ee457', 'rename failed')}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="right" sideOffset={8}>
                  {translate(
                    'auto.components.sidebar.WorktreeCard.4eba2ea99e',
                    'Auto-name failed. Click to see details.'
                  )}
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
                    {translate('auto.components.sidebar.WorktreeCard.7d517f82e2', 'primary')}
                  </Badge>
                </TooltipTrigger>
                <TooltipContent side="right" sideOffset={8}>
                  {translate(
                    'auto.components.sidebar.WorktreeCard.0777de5970',
                    'Primary worktree (original clone directory)'
                  )}
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
                    {translate('auto.components.sidebar.WorktreeCard.4f964d5e8c', 'sparse')}
                  </Badge>
                </TooltipTrigger>
                <TooltipContent side="right" sideOffset={8} className="max-w-72">
                  <div className="space-y-1">
                    <div>
                      {translate(
                        'auto.components.sidebar.WorktreeCard.0f33af979b',
                        'Partial checkout. Files outside these paths are not on disk.'
                      )}
                    </div>
                    {worktree.sparseDirectories && worktree.sparseDirectories.length > 0 ? (
                      <div className="font-mono text-[11px] opacity-80">
                        {formatSparseDirectoryPreview(worktree.sparseDirectories)}
                      </div>
                    ) : null}
                  </div>
                </TooltipContent>
              </Tooltip>
            )}

            {showTitleRowIndicators && titleRowIndicators}
          </div>

          {showHeaderActions && (
            <div className="ml-auto flex shrink-0 items-center justify-center gap-1 pr-1.5">
              {showTitleRowPrimary && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span
                      className="shrink-0 inline-flex items-center"
                      aria-label={translate(
                        'auto.components.sidebar.WorktreeCard.0d224eff10',
                        'Primary worktree'
                      )}
                    >
                      <Star className="size-3 fill-amber-400 text-amber-400" />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="right" sideOffset={8}>
                    {translate(
                      'auto.components.sidebar.WorktreeCard.0777de5970',
                      'Primary worktree (original clone directory)'
                    )}
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
                        'group-hover/worktree-card:opacity-100 group-focus-within/worktree-card:opacity-100 focus-visible:opacity-100',
                        'text-muted-foreground hover:bg-destructive/10 hover:text-destructive focus-visible:bg-destructive/10 focus-visible:text-destructive'
                      )}
                      aria-label={translate(
                        'auto.components.sidebar.WorktreeCard.6f09f58541',
                        'Delete workspace'
                      )}
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="right" sideOffset={8}>
                    {translate(
                      'auto.components.sidebar.WorktreeCard.6f09f58541',
                      'Delete workspace'
                    )}
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

              {showHostContextBadge && (
                <Badge
                  variant="secondary"
                  className="h-[16px] max-w-[7rem] shrink-0 rounded border border-border bg-accent px-1.5 text-[10px] font-medium leading-none text-muted-foreground dark:bg-accent/80 dark:border-border/50"
                >
                  <span className="truncate">{hostContextLabel}</span>
                </Badge>
              )}

              {showIdentityInNewCard ? (
                <TruncatedSidebarLabel
                  text={identityDisplay!}
                  className="text-[11px] text-muted-foreground leading-none"
                  tooltipEnabled={!hasHoverDetails}
                />
              ) : isFolder && !newCardStyle ? (
                <span
                  className="min-w-0 truncate font-mono text-[11px] leading-none text-muted-foreground"
                  title={worktree.path}
                >
                  {getDirectoryName(worktree.path)}
                </span>
              ) : showBranch ? (
                <TruncatedSidebarLabel
                  text={branch}
                  className="text-[11px] text-muted-foreground leading-none"
                  // Why: whole-card details hover already shows full identity; a nested tooltip would compete for it.
                  tooltipEnabled={!hasHoverDetails}
                />
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
              {translate(
                'auto.components.sidebar.WorktreeCard.a88c92d0e3',
                '{{value0}}/{{value1}} already exists.',
                {
                  value0: remoteBranchConflict.remote,
                  value1: remoteBranchConflict.branchName
                }
              )}
            </span>
          </div>
        )}

        {isActive && worktree.linkedLinearIssue ? (
          <LinearAgentSkillSetupPrompt
            linked
            remote={Boolean(repo?.connectionId || settings?.activeRuntimeEnvironmentId?.trim())}
            surface="modal"
            settings={settings}
          />
        ) : null}

        {/* Why: counterbalance the card stack gap (-mt-1) so agents right after the title read as one header group. */}
        {showInlineAgentList && (
          <WorktreeCardAgents
            worktreeId={worktree.id}
            agents={agentActivityDisplayMode === 'compact' ? compactInlineAgentRows : undefined}
            className={hasMetaRow || remoteBranchConflict ? 'mt-0' : '-mt-1'}
          />
        )}

        {showLineageChildChip && (
          <div
            className={cn('relative mt-1 flex min-w-0 justify-start', !newCardStyle && '-ml-1')}
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
                  aria-label={lineageChildAriaLabel}
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
                {lineageCollapsed
                  ? translate(
                      'auto.components.sidebar.WorktreeCard.8cb634cda6',
                      'Show child workspaces'
                    )
                  : translate(
                      'auto.components.sidebar.WorktreeCard.57eaa61b55',
                      'Hide child workspaces'
                    )}
              </TooltipContent>
            </Tooltip>
          </div>
        )}

        {!newCardStyle && lineageChildren && (
          <div className="-ml-[1.125rem] mt-1.5 w-[calc(100%+1.125rem)] space-y-1">
            {lineageChildren}
          </div>
        )}
      </div>
    </div>
  )

  const parentHoverTriggerBody = (
    <div className="group/worktree-card w-full min-w-0" data-worktree-card-hover-trigger="">
      {parentCardContent}
    </div>
  )

  const parentCardBodyWithHoverDetails =
    hasHoverDetails && !titleRenaming ? (
      <WorktreeCardDetailsHover
        issue={hoverIssue}
        linearIssue={hoverLinearIssue}
        review={hoverReview}
        comment={hoverComment}
        automationProvenance={metaAutomationProvenance}
        automationHostId={worktree.hostId}
        branchName={hoverBranchName}
        workspaceTitle={hoverWorkspaceTitle}
        workspaceTitleRenameDisabled={isDeleting || affiliateListMode}
        detailsAfter={
          workspacePorts.length > 0 ? <WorktreeCardPortsDetails ports={workspacePorts} /> : null
        }
        openDelay={100}
        hoverControl={detailsHoverControl}
        onRenameWorkspaceTitle={affiliateListMode ? undefined : handleRenameTitle}
        onEditIssue={affiliateListMode ? undefined : handleEditIssue}
        onEditComment={affiliateListMode ? undefined : handleEditComment}
        onOpenGitHubIssueInOrca={
          hoverIssue && 'url' in hoverIssue && hoverIssue.url
            ? handleOpenGitHubIssueInOrca
            : undefined
        }
        onOpenLinearIssueInOrca={linearIssue?.url ? handleOpenLinearIssueInOrca : undefined}
        onOpenReviewInOrca={
          hoverReview?.url && hoverReview.provider === 'github' ? handleOpenReviewInOrca : undefined
        }
        onOpenAutomation={affiliateListMode ? undefined : handleOpenAutomation}
        onOpenAutomationRun={affiliateListMode ? undefined : handleOpenAutomationRun}
        // Why: branch lookup can surface a review without persisted metadata; only unlink when explicitly linked.
        onUnlinkReview={
          !affiliateListMode && hasExplicitLinkedReview ? handleUnlinkReview : undefined
        }
      >
        {parentHoverTriggerBody}
      </WorktreeCardDetailsHover>
    ) : (
      parentHoverTriggerBody
    )

  const cardBody = (
    <div
      className={cn(
        'relative flex cursor-pointer flex-col pr-1.5 transition-[background-color,border-color,opacity,box-shadow] duration-200 outline-none select-none',
        titleOnlyCard ? 'py-2' : 'pt-1.25 pb-1.5',
        flushSurface ? 'ml-1 w-[calc(100%-0.25rem)]' : 'ml-1',
        'rounded-lg',
        isLineageDropTarget
          ? 'border border-accent-foreground/20 bg-accent/80'
          : isActiveSurface
            ? activeSurfaceIsSecondary
              ? 'border border-sidebar-ring/25 bg-sidebar-accent/45 shadow-none ring-1 ring-sidebar-ring/15'
              : 'bg-black/[0.08] shadow-[0_1px_2px_rgba(0,0,0,0.04)] border border-black/[0.015] dark:bg-white/[0.10] dark:border-border/40 dark:shadow-[0_1px_2px_rgba(0,0,0,0.03)]'
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
        (isSshDisconnected || isRuntimeDisconnected) && !isDeleting && 'opacity-60'
      )}
      data-worktree-card-surface="true"
      data-worktree-card-active={isActiveSurface ? activeSurfaceVariant : undefined}
      onClick={handleClick}
      onDoubleClick={affiliateListMode ? undefined : handleDoubleClick}
      draggable={!affiliateListMode && nativeDragEnabled && !isDeleting && !titleRenaming}
      onDragStart={!affiliateListMode && nativeDragEnabled ? handleDragStart : undefined}
      onDragEnd={!affiliateListMode && nativeDragEnabled ? handleDragEnd : undefined}
      aria-busy={isDeleting}
      style={cardStyle}
    >
      {isDeleting && (
        <div className="absolute inset-0 z-10 flex items-center justify-center rounded-lg bg-background/50 backdrop-blur-[1px]">
          <div className="inline-flex items-center gap-1.5 rounded-full bg-background px-3 py-1 text-[11px] font-medium text-foreground shadow-sm border border-border/50">
            {!isQueuedForDeletion ? (
              <LoaderCircle className="size-3.5 animate-spin text-muted-foreground" />
            ) : null}
            {deleteLabel}
          </div>
        </div>
      )}
      {parentCardBodyWithHoverDetails}

      {newCardStyle && lineageChildren ? (
        <div
          className="mt-1.5 space-y-1"
          data-worktree-lineage-children=""
          style={lineageChildrenStyle}
        >
          {lineageChildren}
        </div>
      ) : null}
    </div>
  )

  return (
    <>
      {affiliateListMode ? (
        cardBody
      ) : (
        <WorktreeContextMenu
          worktree={worktree}
          selectedWorktrees={selectedWorktrees}
          onContextMenuSelect={handleContextMenuSelect}
        >
          {cardBody}
        </WorktreeContextMenu>
      )}

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
            worktreeId={worktree.id}
            worktreeName={worktree.displayName}
            error={worktree.firstAgentMessageRenameError}
          />
        )}
    </>
  )
})

export default WorktreeCard
