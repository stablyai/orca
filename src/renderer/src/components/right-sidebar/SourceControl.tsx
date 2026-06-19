/* eslint-disable max-lines */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronDown,
  Minus,
  Plus,
  Undo2,
  Check,
  Copy,
  GitFork,
  MessageSquare,
  Trash,
  Trash2,
  MoreHorizontal
} from 'lucide-react'
import { useAppStore } from '@/store'
import { resolveRemoteOperationErrorMessage } from '@/store/slices/editor'
import { useActiveWorktree, useRepoById, useWorktreeMap } from '@/store/selectors'
import { getHostedReviewCacheKey } from '@/store/slices/hosted-review'
import { getGitHubPRCacheKey } from '@/store/slices/github-cache-key'
import { detectLanguage } from '@/lib/language-detect'
import { joinPath } from '@/lib/path'
import { cn } from '@/lib/utils'
import { isFolderRepo } from '../../../../shared/repo-kind'
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip'
import { Button } from '@/components/ui/button'
import { DetachedHeadBadge } from '@/components/DetachedHeadBadge'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import {
  resolveCommitAreaPrimaryAction,
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
  isStageableStatusEntry,
  runDiscardAllForArea,
  type DiscardAllArea
} from './discard-all-sequence'
import {
  buildGitStatusSourceControlTree,
  buildSourceControlTree,
  compactSourceControlTree,
  flattenSourceControlTree
} from './source-control-tree'
import {
  buildActiveOpenFileSignature,
  buildActiveOpenRowKeys
} from './source-control-active-open-file-keys'
import {
  SourceControlDiscardDialog,
  type PendingDiscardConfirmation
} from './source-control-discard-dialog'
import {
  refreshGitStatusForWorktree,
  refreshGitStatusForWorktreeStrict
} from './git-status-refresh'
import { describeForkPushTarget } from './fork-push-target-label'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { BaseRefPicker } from '@/components/settings/BaseRefPicker'
import { useConfirmationDialog } from '@/components/confirmation-dialog'
import { formatDiffComments } from '@/lib/diff-comments-format'
import { getDiffCommentSource } from '@/lib/diff-comment-compat'
import { DiffNotesSendMenu } from '@/components/editor/DiffNotesSendMenu'
import {
  countPendingDiffCommentsClear,
  formatPendingDiffCommentsClearDescription,
  resolvePendingDiffCommentsClear,
  type PendingDiffCommentsClear
} from './diff-comments-clear-dialog-state'
import { readSourceControlLaunchRecipeAgentId } from '@/lib/source-control-launch-agent-selection'
import { installWindowVisibilityInterval } from '@/lib/window-visibility-interval'
import {
  notifyEditorExternalFileChange,
  requestEditorSaveQuiesce
} from '@/components/editor/editor-autosave'
import { getConnectionId } from '@/lib/connection-context'
import { getRepoOwnerRoutedSettings } from '@/lib/repo-runtime-owner'
import {
  abortRuntimeGitMerge,
  abortRuntimeGitRebase,
  bulkDiscardRuntimeGitPaths,
  bulkStageRuntimeGitPaths,
  bulkUnstageRuntimeGitPaths,
  cancelRuntimeGenerateCommitMessage,
  cancelRuntimeGeneratePullRequestFields,
  commitRuntimeGit,
  discardRuntimeGitPath,
  generateRuntimeCommitMessage,
  generateRuntimePullRequestFields,
  getRuntimeGitBranchCompare,
  getRuntimeGitHistory,
  stageRuntimeGitPath,
  unstageRuntimeGitPath,
  type RuntimeGitContext,
  type RuntimeGenerateCommitMessageOverrides,
  type RuntimeGeneratePullRequestFieldsOverrides
} from '@/runtime/runtime-git-client'
import { getRuntimeRepoBaseRefDefault } from '@/runtime/runtime-repo-client'

import { stripBaseRef, useCreatePullRequestDialogFields } from './useCreatePullRequestDialogFields'
import { GitHistoryPanel, type GitHistoryPanelState } from './GitHistoryPanel'
import { useGitHistoryCommitActions } from './useGitHistoryCommitActions'
import { normalizeHostedReviewHeadRef } from '../../../../shared/hosted-review-refs'
import { shouldForcePushWithLeaseForUpstream } from '../../../../shared/git-upstream-status'
import type {
  DiffComment,
  GitBranchChangeEntry,
  GitConflictOperation,
  GitPushTarget,
  GitStatusEntry,
  GitUpstreamStatus,
  SourceControlViewMode
} from '../../../../shared/types'
import type {
  HostedReviewCreationEligibility,
  HostedReviewInfo,
  HostedReviewProvider
} from '../../../../shared/hosted-review'
import { resolveHostedReviewCreationProvider } from '../../../../shared/hosted-review-creation-providers'
import { humanizeBranchSlug } from '../../../../shared/branch-name-from-work'
import { isCustomAgentId } from '../../../../shared/commit-message-agent-spec'
import { getWorktreeGitIdentityDisplay } from '@/lib/worktree-git-identity-display'
import { resolveSourceControlLaunchPlatform } from '@/lib/source-control-launch-platform'
import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import {
  isSourceControlSplitOpenModifier,
  shouldOpenSourceControlRowAsPreview,
  type SourceControlRowOpenEvent
} from './source-control-split-open'
import { SourceControlAgentActionDialog } from './SourceControlAgentActionDialog'
import { SourceControlTextGenerationDialog } from './SourceControlTextGenerationDialog'
import { CreateHostedReviewComposer } from './CreateHostedReviewComposer'
import {
  hasConfiguredCommitMessageGenerationDefaults,
  hasConfiguredSourceControlTextGenerationDefaults
} from './source-control-text-generation-defaults'
import { useCopyFeedbackState } from './source-control-copy-feedback-state'
import { getSourceControlDirectoryActionPaths } from './source-control-directory-action-paths'
import { compareGitStatusEntries } from './source-control-status-sort'
import { CommitArea, type CreatePrIntentNotice } from './source-control-commit-area'
import { CompareUnavailable } from './source-control-compare-summary'
import { SectionHeader } from './source-control-section-header'
import { DiffCommentsInlineList } from './source-control-diff-comments-inline-list'
import {
  ConflictSummaryCard,
  OperationBanner,
  TooManyChangesBanner
} from './source-control-conflict-summary-card'
import {
  SourceControlTreeDirectoryRow,
  UncommittedEntryRow
} from './source-control-uncommitted-entry-rows'
import {
  BranchEntryRow,
  SourceControlBranchTreeDirectoryRow
} from './source-control-branch-entry-rows'
import { ActionButton } from './source-control-entry-action-button'
import { useSourceControlAi } from './use-source-control-ai'
import { translate } from '@/i18n/i18n'
import {
  localizedHostedReviewCopy,
  resolveSupportedHostedReviewCopyProvider
} from '@/i18n/hosted-review-localized-copy'
import {
  createCreatePrIntentRunToken,
  createPrIntentCurrentTargetConflictsWithToken,
  createPrIntentGitStatusMatchesToken,
  createPrIntentRunTokenMatches,
  getCreatePrIntentStagePaths,
  resolveCreatePrIntentRemoteStep,
  type CreatePrIntentRunToken
} from './source-control-create-pr-intent-flow'
import { resolveVisibleCreatePrHeaderAction } from './source-control-create-pr-intent-state'
import {
  buildLoadingHostedReviewCreationEligibility,
  resolveCreatePrHeaderAction,
  resolveProvisionalHostedReviewProvider
} from './source-control-primary-create-pr-intent-action'
import {
  getNextSourceControlViewMode,
  shouldShowSourceControlCompareUnavailableCard,
  SourceControlHeaderToolbar
} from './source-control-header-toolbar'
export { HostedReviewHeaderLink } from './hosted-review-header-chrome'
import {
  createRunningCommitMessageGenerationRecord,
  getCommitMessageGenerationRecordKey,
  markCommitMessageGenerationHydrated,
  resolveCommitMessageGenerationCancel,
  resolveCommitMessageGenerationFailure,
  resolveCommitMessageGenerationSuccess,
  type CommitMessageGenerationRecord
} from '@/store/slices/commit-message-generation'
import {
  createRunningPullRequestGenerationRecord,
  getPullRequestGenerationRecordKey,
  resolvePullRequestGenerationCancel,
  resolvePullRequestGenerationFailure,
  resolvePullRequestGenerationSuccess,
  shouldHydratePullRequestGenerationResult,
  type PullRequestFieldRevisions,
  type PullRequestGenerationContext,
  type PullRequestGenerationFields
} from '@/store/slices/pull-request-generation'

export {
  hasConfiguredCommitMessageGenerationDefaults,
  hasConfiguredSourceControlTextGenerationDefaults
} from './source-control-text-generation-defaults'

type AbortConflictOperation = Extract<GitConflictOperation, 'merge' | 'rebase'>
type AbortActionErrorKind = 'abort_merge' | 'abort_rebase'
export type SourceControlActionError = {
  kind: RemoteOpKind | AbortActionErrorKind
  message: string
}
type SourceControlOperationTarget = RuntimeGitContext & {
  worktreeId: string
  pushTarget?: GitPushTarget
}
type HostedReviewCreatedContext = {
  repoPath: string
  repoId: string
  branch: string
  worktreeId: string | null
  openChecks: boolean
}
export function resolveSourceControlBaseRef(input: {
  worktreeBaseRef?: string | null
  reviewBaseRefName?: string | null
  repoBaseRef?: string | null
  defaultBaseRef?: string | null
}): string | null {
  const worktreeBaseRef = input.worktreeBaseRef?.trim() || null
  const hasReviewBaseRefName = Boolean(input.reviewBaseRefName?.trim())
  const reviewBaseRef = resolveHostedReviewCompareBaseRef(input.reviewBaseRefName, [
    input.repoBaseRef,
    input.defaultBaseRef
  ])
  if (worktreeBaseRef && isFullGitCommitOid(worktreeBaseRef) && hasReviewBaseRefName) {
    return reviewBaseRef
  }
  return worktreeBaseRef || input.repoBaseRef?.trim() || input.defaultBaseRef?.trim() || null
}

export function resolveSourceControlPickerBaseRef(input: {
  pinnedBaseRef?: string | null
  effectiveBaseRef?: string | null
}): string | undefined {
  const pinnedBaseRef = input.pinnedBaseRef?.trim()
  if (!pinnedBaseRef) {
    return undefined
  }
  return input.effectiveBaseRef?.trim() || pinnedBaseRef
}

function isFullGitCommitOid(value: string): boolean {
  return /^[0-9a-f]{40}$/i.test(value)
}

function resolveHostedReviewCompareBaseRef(
  baseRefName: string | null | undefined,
  candidates: (string | null | undefined)[]
): string | null {
  const branch = baseRefName?.trim()
  if (!branch) {
    return null
  }
  for (const candidate of candidates) {
    const trimmed = candidate?.trim()
    if (!trimmed) {
      continue
    }
    if (getCompareBaseCandidateBranchName(trimmed) === branch) {
      return trimmed
    }
  }
  for (const candidate of candidates) {
    const rewritten = rewriteCompareBaseBranchFromCandidate(candidate, branch)
    if (rewritten) {
      return rewritten
    }
  }
  return null
}

function getCompareBaseCandidateBranchName(candidate: string): string {
  const remoteRefPrefix = 'refs/remotes/'
  if (candidate.startsWith(remoteRefPrefix)) {
    const remoteAndBranch = candidate.slice(remoteRefPrefix.length)
    const slashIndex = remoteAndBranch.indexOf('/')
    return slashIndex > 0 ? remoteAndBranch.slice(slashIndex + 1) : remoteAndBranch
  }
  const headsRefPrefix = 'refs/heads/'
  if (candidate.startsWith(headsRefPrefix)) {
    return candidate.slice(headsRefPrefix.length)
  }
  const slashIndex = candidate.indexOf('/')
  return slashIndex > 0 ? candidate.slice(slashIndex + 1) : candidate
}

function rewriteCompareBaseBranchFromCandidate(
  candidate: string | null | undefined,
  branch: string
): string | null {
  const trimmed = candidate?.trim()
  if (!trimmed) {
    return null
  }
  const remoteRefPrefix = 'refs/remotes/'
  if (trimmed.startsWith(remoteRefPrefix)) {
    const remoteAndBranch = trimmed.slice(remoteRefPrefix.length)
    const slashIndex = remoteAndBranch.indexOf('/')
    return slashIndex > 0
      ? `${remoteRefPrefix}${remoteAndBranch.slice(0, slashIndex)}/${branch}`
      : null
  }
  const headsRefPrefix = 'refs/heads/'
  if (trimmed.startsWith(headsRefPrefix)) {
    return `${headsRefPrefix}${branch}`
  }
  const slashIndex = trimmed.indexOf('/')
  return slashIndex > 0 ? `${trimmed.slice(0, slashIndex)}/${branch}` : null
}

const EMPTY_GIT_STATUS_ENTRIES: GitStatusEntry[] = []
const EMPTY_BRANCH_CHANGE_ENTRIES: GitBranchChangeEntry[] = []

// Why: the "too many changes — add folder to .gitignore?" warning shows at most
// once per worktree per session (the analog of a "Don't show again" gate), so a
// repo that stays huge across polls doesn't re-toast every refresh.
const hugeRepoWarningDismissed = new Set<string>()

// Why: unstaged ("Changes") is listed first so that conflict files — which
// are assigned area:'unstaged' by the parser — appear above "Staged Changes".
// This keeps unresolved conflicts visible at the top of the list where the
// user won't miss them.
const SECTION_ORDER = ['unstaged', 'staged', 'untracked'] as const
const SECTION_LABELS: Record<(typeof SECTION_ORDER)[number], { key: string; fallback: string }> = {
  staged: {
    key: 'auto.components.right.sidebar.SourceControl.48a003c1b1',
    fallback: 'Staged Changes'
  },
  unstaged: {
    key: 'auto.components.right.sidebar.SourceControl.d4ef4bafc5',
    fallback: 'Changes'
  },
  untracked: {
    key: 'auto.components.right.sidebar.SourceControl.522f44dce5',
    fallback: 'Untracked Files'
  }
}

const BRANCH_REFRESH_INTERVAL_MS = 5000
const EMPTY_GIT_HISTORY_STATE: GitHistoryPanelState = { status: 'idle' }
const DEFAULT_COLLAPSED_SECTIONS = ['history'] as const

function createDefaultCollapsedSections(): Set<string> {
  return new Set(DEFAULT_COLLAPSED_SECTIONS)
}

function cancelSourceControlEditorRevealFrames(frameIds: React.MutableRefObject<number[]>): void {
  for (const frameId of frameIds.current) {
    cancelAnimationFrame(frameId)
  }
  frameIds.current = []
}

function requestSourceControlEditorRevealFrame(
  frameIds: React.MutableRefObject<number[]>,
  callback: FrameRequestCallback
): void {
  let completed = false
  let frameId: number | undefined
  frameId = requestAnimationFrame((timestamp) => {
    completed = true
    if (frameId !== undefined) {
      frameIds.current = frameIds.current.filter((pendingFrameId) => pendingFrameId !== frameId)
    }
    callback(timestamp)
  })
  if (!completed) {
    frameIds.current.push(frameId)
  }
}

// Why: the pure state-machine logic now lives in
// ./source-control-primary-action.ts. It is imported directly by callers
// (tests and other components) instead of going through this module.

type CommitDraftsByWorktree = Record<string, string>

export function normalizeSourceControlViewMode(value: unknown): SourceControlViewMode {
  return value === 'tree' || value === 'list' ? value : 'list'
}

type HostedReviewCreationState = {
  repoId: string
  worktreeId: string
  branch: string
  data: HostedReviewCreationEligibility
}

type HostedReviewCreationRequestState = {
  repoId: string
  worktreeId: string
  branch: string
  status: 'loading' | 'failed'
}

type CreatedHostedReview = {
  provider: HostedReviewProvider
  number: number
  url: string
}

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

export function shouldRenderCommitArea(
  unresolvedConflictCount: number,
  conflictOperation: GitConflictOperation
): boolean {
  return unresolvedConflictCount === 0 && conflictOperation === 'unknown'
}

function resolveRemoteActionError(kind: RemoteOpKind, error: unknown): string {
  return resolveRemoteOperationErrorMessage(error, {
    publish: kind === 'publish',
    isPush: kind === 'push',
    isForcePush: kind === 'force_push',
    isSync: kind === 'sync',
    isFetch: kind === 'fetch',
    isFastForward: kind === 'fast_forward',
    isRebase: kind === 'rebase'
  })
}

export function refreshSourceControlAfterRemoteAction({
  refreshGitStatus,
  refreshBranchCompare,
  refreshGitHistory,
  onError = (error) => console.warn('[SourceControl] post-remote refresh failed', error)
}: {
  refreshGitStatus: () => Promise<void>
  refreshBranchCompare: () => Promise<void>
  refreshGitHistory: () => Promise<void>
  onError?: (error: unknown) => void
}): void {
  // Why: fetch/sync can move the remote base ref without changing local files.
  // Refresh all three visible git projections so the branch comparison table
  // re-runs against the newly fetched base instead of waiting for polling.
  void Promise.all([refreshGitStatus(), refreshBranchCompare(), refreshGitHistory()]).catch(onError)
}

function remoteActionErrorMatchesSettledConflictOperation(
  kind: SourceControlActionError['kind'],
  operation: GitConflictOperation
): boolean {
  if (kind === 'rebase' || kind === 'abort_rebase') {
    return operation === 'rebase'
  }
  if (kind === 'abort_merge') {
    return operation === 'merge'
  }
  if (kind === 'pull' || kind === 'sync') {
    return operation === 'merge' || operation === 'rebase'
  }
  return false
}

export function clearRemoteActionErrorsForCompletedConflictOperations({
  remoteActionErrors,
  previousConflictOperations,
  currentConflictOperations
}: {
  remoteActionErrors: Record<string, SourceControlActionError | null>
  previousConflictOperations: Record<string, GitConflictOperation>
  currentConflictOperations: Record<string, GitConflictOperation>
}): Record<string, SourceControlActionError | null> {
  let next: Record<string, SourceControlActionError | null> | null = null
  for (const [worktreeId, error] of Object.entries(remoteActionErrors)) {
    if (!error) {
      continue
    }
    const previousOperation = previousConflictOperations[worktreeId] ?? 'unknown'
    const currentOperation = currentConflictOperations[worktreeId] ?? 'unknown'
    if (
      previousOperation === 'unknown' ||
      currentOperation !== 'unknown' ||
      !remoteActionErrorMatchesSettledConflictOperation(error.kind, previousOperation)
    ) {
      continue
    }
    next ??= { ...remoteActionErrors }
    next[worktreeId] = null
  }
  return next ?? remoteActionErrors
}

function SourceControlInner(): React.JSX.Element {
  const sourceControlRef = useRef<HTMLDivElement | null>(null)
  const isMac = useMemo(() => navigator.userAgent.includes('Mac'), [])
  const pendingCommentEditorRevealFrameIdsRef = useRef<number[]>([])
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
  const entries = useAppStore((s) =>
    activeWorktreeId
      ? (s.gitStatusByWorktree[activeWorktreeId] ?? EMPTY_GIT_STATUS_ENTRIES)
      : EMPTY_GIT_STATUS_ENTRIES
  )
  const repositoryHuge = useAppStore((s) =>
    activeWorktreeId ? s.gitStatusHugeByWorktree?.[activeWorktreeId] : undefined
  )
  const branchEntries = useAppStore((s) =>
    activeWorktreeId
      ? (s.gitBranchChangesByWorktree[activeWorktreeId] ?? EMPTY_BRANCH_CHANGE_ENTRIES)
      : EMPTY_BRANCH_CHANGE_ENTRIES
  )
  const branchSummary = useAppStore((s) =>
    activeWorktreeId ? (s.gitBranchCompareSummaryByWorktree[activeWorktreeId] ?? null) : null
  )
  const conflictOperation = useAppStore((s) =>
    activeWorktreeId ? (s.gitConflictOperationByWorktree[activeWorktreeId] ?? 'unknown') : 'unknown'
  )
  const conflictOperationsByWorktree = useAppStore((s) => s.gitConflictOperationByWorktree)
  // Why: leave undefined until fetchUpstreamStatus resolves for this worktree.
  // A synthetic "no upstream" flashes "Publish Branch" during worktree switches.
  const remoteStatus = useAppStore((s) =>
    activeWorktreeId ? s.remoteStatusesByWorktree[activeWorktreeId] : undefined
  )
  const isRemoteOperationActive = useAppStore((s) => s.isRemoteOperationActive)
  const inFlightRemoteOpKind = useAppStore((s) => s.inFlightRemoteOpKind)
  const settings = useAppStore((s) => s.settings)
  // Why: git/file mutations and repo metadata requests belong to the repo
  // OWNER host, not the currently focused host in the sidebar.
  const activeRepoSettings = useMemo(
    () => getRepoOwnerRoutedSettings(settings, activeRepo ?? null),
    [activeRepo, settings]
  )
  const updateSettings = useAppStore((s) => s.updateSettings)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const hostedReviewCache = useAppStore((s) => s.hostedReviewCache)
  const fetchHostedReviewForBranch = useAppStore((s) => s.fetchHostedReviewForBranch)
  const getHostedReviewCreationEligibility = useAppStore(
    (s) => s.getHostedReviewCreationEligibility
  )
  const createHostedReview = useAppStore((s) => s.createHostedReview)
  const updateWorktreeMeta = useAppStore((s) => s.updateWorktreeMeta)
  const fetchPRForBranch = useAppStore((s) => s.fetchPRForBranch)
  const prCache = useAppStore((s) => s.prCache)
  const enqueueGitHubPRRefresh = useAppStore((s) => s.enqueueGitHubPRRefresh)
  const updateRepo = useAppStore((s) => s.updateRepo)
  const setGitStatus = useAppStore((s) => s.setGitStatus)
  const updateWorktreeGitIdentity = useAppStore((s) => s.updateWorktreeGitIdentity)
  const beginGitBranchCompareRequest = useAppStore((s) => s.beginGitBranchCompareRequest)
  const setGitBranchCompareResult = useAppStore((s) => s.setGitBranchCompareResult)
  const fetchUpstreamStatus = useAppStore((s) => s.fetchUpstreamStatus)
  const setUpstreamStatus = useAppStore((s) => s.setUpstreamStatus)
  const pushBranch = useAppStore((s) => s.pushBranch)
  const pullBranch = useAppStore((s) => s.pullBranch)
  const fastForwardBranch = useAppStore((s) => s.fastForwardBranch)
  const syncBranch = useAppStore((s) => s.syncBranch)
  const rebaseFromBase = useAppStore((s) => s.rebaseFromBase)
  const fetchBranch = useAppStore((s) => s.fetchBranch)
  const revealInExplorer = useAppStore((s) => s.revealInExplorer)
  const trackConflictPath = useAppStore((s) => s.trackConflictPath)
  const openDiff = useAppStore((s) => s.openDiff)
  const openFile = useAppStore((s) => s.openFile)
  const setEditorViewMode = useAppStore((s) => s.setEditorViewMode)
  const setMarkdownViewMode = useAppStore((s) => s.setMarkdownViewMode)
  const setPendingEditorReveal = useAppStore((s) => s.setPendingEditorReveal)
  const openConflictFile = useAppStore((s) => s.openConflictFile)
  const openConflictReview = useAppStore((s) => s.openConflictReview)
  const openBranchDiff = useAppStore((s) => s.openBranchDiff)
  const createEmptySplitGroup = useAppStore((s) => s.createEmptySplitGroup)
  const groupsByWorktree = useAppStore((s) => s.groupsByWorktree)
  const activeGroupIdByWorktree = useAppStore((s) => s.activeGroupIdByWorktree)
  const openAllDiffs = useAppStore((s) => s.openAllDiffs)
  const openBranchAllDiffs = useAppStore((s) => s.openBranchAllDiffs)
  const deleteDiffComment = useAppStore((s) => s.deleteDiffComment)
  const clearDiffComments = useAppStore((s) => s.clearDiffComments)
  const clearDiffCommentsForFile = useAppStore((s) => s.clearDiffCommentsForFile)
  const setScrollToDiffCommentId = useAppStore((s) => s.setScrollToDiffCommentId)
  const setRightSidebarOpen = useAppStore((s) => s.setRightSidebarOpen)
  const setRightSidebarTab = useAppStore((s) => s.setRightSidebarTab)
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
  const [diffCommentsCopied, showDiffCommentsCopied] = useCopyFeedbackState(false)
  const [pendingDiffCommentsClear, setPendingDiffCommentsClear] =
    useState<PendingDiffCommentsClear | null>(null)
  const [isClearingDiffComments, setIsClearingDiffComments] = useState(false)
  const setSourceControlRoot = useCallback((node: HTMLDivElement | null) => {
    // Why: markdown-note reveal frames target the Source Control surface; cancel
    // them when that surface unmounts instead of from a passive Effect.
    if (node === null) {
      cancelSourceControlEditorRevealFrames(pendingCommentEditorRevealFrameIdsRef)
    }
    sourceControlRef.current = node
  }, [])

  const handleCopyDiffComments = useCallback(async (): Promise<void> => {
    if (diffCommentsForActive.length === 0) {
      return
    }
    try {
      await window.api.ui.writeClipboardText(diffCommentsPrompt)
      showDiffCommentsCopied(true)
    } catch {
      // Why: swallow — clipboard write can fail when the window isn't focused.
      // No dedicated error surface is warranted for a best-effort copy action.
    }
  }, [diffCommentsForActive, diffCommentsPrompt, showDiffCommentsCopied])

  const pendingDiffCommentsClearCount = useMemo(() => {
    return countPendingDiffCommentsClear(
      pendingDiffCommentsClear,
      activeWorktreeId,
      diffCommentsForActive
    )
  }, [activeWorktreeId, diffCommentsForActive, pendingDiffCommentsClear])

  const resolvedPendingDiffCommentsClear = resolvePendingDiffCommentsClear({
    activeWorktreeId,
    isClearing: isClearingDiffComments,
    pending: pendingDiffCommentsClear,
    pendingCount: pendingDiffCommentsClearCount
  })
  if (resolvedPendingDiffCommentsClear !== pendingDiffCommentsClear) {
    // Why: the confirmation is purely local UI state; clear impossible
    // confirmations before children observe a stale open dialog.
    setPendingDiffCommentsClear(resolvedPendingDiffCommentsClear)
  }

  const pendingDiffCommentsClearDescription = formatPendingDiffCommentsClearDescription(
    resolvedPendingDiffCommentsClear,
    pendingDiffCommentsClearCount
  )

  const handleConfirmDiffCommentsClear = useCallback(async (): Promise<void> => {
    const pending = resolvedPendingDiffCommentsClear
    if (!pending || isClearingDiffComments || pending.worktreeId !== activeWorktreeId) {
      return
    }
    if (pendingDiffCommentsClearCount === 0) {
      setPendingDiffCommentsClear(null)
      return
    }
    setIsClearingDiffComments(true)
    try {
      const ok =
        pending.kind === 'all'
          ? await clearDiffComments(pending.worktreeId)
          : await clearDiffCommentsForFile(pending.worktreeId, pending.filePath)
      if (ok) {
        setPendingDiffCommentsClear(null)
      } else {
        toast.error(
          translate(
            'auto.components.right.sidebar.SourceControl.eae7a1da5f',
            'Failed to clear notes.'
          )
        )
      }
    } finally {
      setIsClearingDiffComments(false)
    }
  }, [
    activeWorktreeId,
    clearDiffComments,
    clearDiffCommentsForFile,
    isClearingDiffComments,
    resolvedPendingDiffCommentsClear,
    pendingDiffCommentsClearCount
  ])

  const [filterExpanded, setFilterExpanded] = useState(false)
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(
    createDefaultCollapsedSections
  )
  const persistedSourceControlViewMode = normalizeSourceControlViewMode(
    settings?.sourceControlViewMode
  )
  const sourceControlViewMode = persistedSourceControlViewMode
  const [collapsedTreeDirs, setCollapsedTreeDirs] = useState<Set<string>>(new Set())
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
  const commitDraftsRef = useRef<CommitDraftsByWorktree>(commitDrafts)
  const [commitErrors, setCommitErrors] = useState<Record<string, string | null>>({})
  const [remoteActionErrors, setRemoteActionErrors] = useState<
    Record<string, SourceControlActionError | null>
  >({})
  const previousConflictOperationsRef = useRef<Record<string, GitConflictOperation>>({})
  // Why: keep commit-in-flight state per-worktree. A single boolean would be
  // cleared when the user switched worktrees, letting them double-click Commit
  // on worktree A after briefly navigating to B and back while A's original
  // commit is still running.
  const [commitInFlightByWorktree, setCommitInFlightByWorktree] = useState<Record<string, boolean>>(
    {}
  )
  const [abortOperationInFlightByWorktree, setAbortOperationInFlightByWorktree] = useState<
    Record<string, boolean>
  >({})
  const isAbortingOperation = abortOperationInFlightByWorktree[activeWorktreeId ?? ''] ?? false
  const confirmAction = useConfirmationDialog()
  const isCommitting = commitInFlightByWorktree[activeWorktreeId ?? ''] ?? false
  // Why: parallel state to commit. Same per-worktree shape so navigating between
  // worktrees mid-generation never silently cancels the in-flight request.
  const generateInFlightRef = useRef<Record<string, boolean>>({})
  const [generateInFlightByWorktree, setGenerateInFlightByWorktree] = useState<
    Record<string, boolean>
  >({})
  const [generateErrors, setGenerateErrors] = useState<Record<string, string | null>>({})
  const [hostedReviewCreationState, setHostedReviewCreationState] =
    useState<HostedReviewCreationState | null>(null)
  const [hostedReviewCreationRequestState, setHostedReviewCreationRequestState] =
    useState<HostedReviewCreationRequestState | null>(null)
  const createPrInFlightRef = useRef<Record<string, boolean>>({})
  const [createPrInFlightByWorktree, setCreatePrInFlightByWorktree] = useState<
    Record<string, boolean>
  >({})
  const isCreatingPr = createPrInFlightByWorktree[activeWorktreeId ?? ''] ?? false
  const createPrIntentInFlightRef = useRef<Record<string, boolean>>({})
  const createPrIntentRunTokenRef = useRef<Record<string, CreatePrIntentRunToken | null>>({})
  const createPrIntentCurrentTargetRef = useRef({
    repoId: null as string | null,
    worktreeId: null as string | null,
    worktreePath: null as string | null,
    branch: null as string | null
  })
  const [createPrIntentInFlightByWorktree, setCreatePrIntentInFlightByWorktree] = useState<
    Record<string, boolean>
  >({})
  const [createPrIntentNotices, setCreatePrIntentNotices] = useState<
    Record<string, CreatePrIntentNotice | null>
  >({})
  const isCreatePrIntentInFlight = createPrIntentInFlightByWorktree[activeWorktreeId ?? ''] ?? false
  const createPrIntentNotice = createPrIntentNotices[activeWorktreeId ?? ''] ?? null
  const setCreatePrIntentNoticeForWorktree = useCallback(
    (worktreeId: string, notice: CreatePrIntentNotice | null): void => {
      setCreatePrIntentNotices((prev) => ({ ...prev, [worktreeId]: notice }))
    },
    []
  )
  const createPrIntentRunStillOwnsWorktree = useCallback(
    (token: CreatePrIntentRunToken): boolean =>
      createPrIntentRunTokenRef.current[token.worktreeId] === token,
    []
  )
  const createPrIntentActiveTargetConflicts = useCallback(
    (token: CreatePrIntentRunToken): boolean =>
      createPrIntentCurrentTargetConflictsWithToken(token, createPrIntentCurrentTargetRef.current),
    []
  )
  const getCreatePrIntentOperationTarget = useCallback(
    (token: CreatePrIntentRunToken): SourceControlOperationTarget => ({
      // Why: Create PR intent continues after navigation; keep git commands
      // pinned to the worktree and runtime host that started the sequence.
      settings: activeRepoSettings,
      worktreeId: token.worktreeId,
      worktreePath: token.worktreePath,
      connectionId: getConnectionId(token.worktreeId) ?? undefined,
      pushTarget: worktreeMap.get(token.worktreeId)?.pushTarget
    }),
    [activeRepoSettings, worktreeMap]
  )
  const prGenerationRecords = useAppStore((s) => s.pullRequestGenerationRecords)
  const allocatePullRequestGenerationRequestId = useAppStore(
    (s) => s.allocatePullRequestGenerationRequestId
  )
  const setPullRequestGenerationRecord = useAppStore((s) => s.setPullRequestGenerationRecord)
  const updatePullRequestGenerationRecord = useAppStore((s) => s.updatePullRequestGenerationRecord)

  const commitMessageGenerationRecords = useAppStore((s) => s.commitMessageGenerationRecords)
  const allocateCommitMessageGenerationRequestId = useAppStore(
    (s) => s.allocateCommitMessageGenerationRequestId
  )
  const setCommitMessageGenerationRecord = useAppStore((s) => s.setCommitMessageGenerationRecord)
  const updateCommitMessageGenerationRecord = useAppStore(
    (s) => s.updateCommitMessageGenerationRecord
  )

  const commitMessage = readCommitDraftForWorktree(commitDrafts, activeWorktreeId)
  const commitError = commitErrors[activeWorktreeId ?? ''] ?? null
  const remoteActionError = remoteActionErrors[activeWorktreeId ?? ''] ?? null
  const [gitHistoryByWorktree, setGitHistoryByWorktree] = useState<
    Record<string, GitHistoryPanelState>
  >({})
  const gitHistoryRequestSeqRef = useRef(0)
  const gitHistoryRequestByWorktreeRef = useRef<Record<string, number>>({})
  const gitHistoryState = activeWorktreeId
    ? (gitHistoryByWorktree[activeWorktreeId] ?? EMPTY_GIT_HISTORY_STATE)
    : EMPTY_GIT_HISTORY_STATE
  const isGitHistoryExpanded = !collapsedSections.has('history')

  useEffect(() => {
    commitDraftsRef.current = commitDrafts
  }, [commitDrafts])

  const updateCommitDrafts = useCallback(
    (updater: (drafts: CommitDraftsByWorktree) => CommitDraftsByWorktree): void => {
      const next = updater(commitDraftsRef.current)
      // Why: Create PR intent reads this ref after awaits to avoid overwriting
      // user edits made before React's passive state sync effect runs.
      commitDraftsRef.current = next
      setCommitDrafts(next)
    },
    []
  )

  const isFolder = activeRepo ? isFolderRepo(activeRepo) : false
  const worktreePath = activeWorktree?.path ?? null
  const activeCommitMessageGenerationKey = getCommitMessageGenerationRecordKey(
    activeWorktreeId,
    worktreePath
  )
  const activeCommitMessageGenerationRecord: CommitMessageGenerationRecord | null =
    activeCommitMessageGenerationKey
      ? (commitMessageGenerationRecords[activeCommitMessageGenerationKey] ?? null)
      : null
  const isGenerating =
    activeCommitMessageGenerationRecord?.status === 'running' ||
    (generateInFlightByWorktree[activeWorktreeId ?? ''] ?? false)
  const generateError =
    activeCommitMessageGenerationRecord?.error ?? generateErrors[activeWorktreeId ?? ''] ?? null
  const activeConnectionId = activeWorktreeId
    ? (getConnectionId(activeWorktreeId) ?? activeRepo?.connectionId ?? null)
    : null
  const activeSourceControlLaunchPlatform = resolveSourceControlLaunchPlatform({
    connectionId: activeConnectionId,
    worktreePath,
    projectRuntime: activeConnectionId
      ? undefined
      : getLocalProjectExecutionRuntimeContext(useAppStore.getState(), activeWorktreeId)
  })
  const gitIdentityDisplay = activeWorktree ? getWorktreeGitIdentityDisplay(activeWorktree) : null
  const detachedHeadDisplay = gitIdentityDisplay?.kind === 'detached' ? gitIdentityDisplay : null
  const branchName = gitIdentityDisplay?.kind === 'branch' ? gitIdentityDisplay.branchName : ''
  useEffect(() => {
    createPrIntentCurrentTargetRef.current = {
      repoId: activeRepo?.id ?? null,
      worktreeId: activeWorktreeId ?? null,
      worktreePath,
      branch: branchName
    }
  }, [activeRepo?.id, activeWorktreeId, branchName, worktreePath])
  const activePullRequestGenerationKey = getPullRequestGenerationRecordKey({
    worktreeId: activeWorktreeId,
    worktreePath,
    repoId: activeRepo?.id,
    branch: branchName
  })
  const activePullRequestGenerationRecordCandidate = activePullRequestGenerationKey
    ? (prGenerationRecords[activePullRequestGenerationKey] ?? null)
    : null
  const activePullRequestGenerationRecord =
    activePullRequestGenerationRecordCandidate &&
    activePullRequestGenerationRecordCandidate.context.repoId === activeRepo?.id &&
    activePullRequestGenerationRecordCandidate.context.branch === branchName
      ? activePullRequestGenerationRecordCandidate
      : null
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
      // Why: route git status by the repo OWNER host, not the focused runtime.
      settings: activeRepoSettings,
      worktreeId: activeWorktreeId,
      worktreePath,
      connectionId,
      pushTarget: activeWorktree?.pushTarget,
      deps: {
        setGitStatus,
        updateWorktreeGitIdentity,
        setUpstreamStatus,
        fetchUpstreamStatus
      }
    })
  }, [
    activeRepoSettings,
    activeWorktreeId,
    activeWorktree?.pushTarget,
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

  // Why: when status is truncated at the entry limit, offer (once per worktree)
  // to .gitignore the folder most likely flooding it — the usual cause is a
  // build/dependency dir that should have been ignored. Accepting writes the
  // .gitignore and refreshes, which clears the huge flag and resumes polling.
  // Local-only: the SSH huge-folder write path isn't wired, so skip remote.
  useEffect(() => {
    if (!repositoryHuge || !activeWorktreeId || !worktreePath || activeConnectionId) {
      return
    }
    if (hugeRepoWarningDismissed.has(activeWorktreeId)) {
      return
    }
    const worktreeId = activeWorktreeId
    let cancelled = false
    void window.api.git
      .findHugeFoldersToIgnore({ worktreePath })
      .then((folders) => {
        if (cancelled || folders.length === 0 || hugeRepoWarningDismissed.has(worktreeId)) {
          return
        }
        hugeRepoWarningDismissed.add(worktreeId)
        const folderName = folders[0]
        toast.warning(
          translate(
            'auto.components.right.sidebar.SourceControl.hugeRepoIgnorePrompt',
            'This repository has too many active changes. Add "{{value0}}" to .gitignore?',
            { value0: folderName }
          ),
          {
            action: {
              label: translate(
                'auto.components.right.sidebar.SourceControl.hugeRepoIgnoreAction',
                'Add to .gitignore'
              ),
              onClick: () => {
                void window.api.git
                  .appendGitignore({ worktreePath, folderName })
                  .then(() => refreshActiveGitStatus())
                  .catch((error) => console.warn('[SourceControl] add to .gitignore failed', error))
              }
            }
          }
        )
      })
      .catch((error) => console.warn('[SourceControl] findHugeFoldersToIgnore failed', error))
    return () => {
      cancelled = true
    }
  }, [repositoryHuge, activeWorktreeId, worktreePath, activeConnectionId, refreshActiveGitStatus])

  const refreshGitStatusAfterPullRequestGeneration = useCallback(
    async (context: PullRequestGenerationContext): Promise<void> => {
      if (!context.worktreeId || isFolder) {
        return
      }
      try {
        await refreshGitStatusForWorktree({
          // Why: generation can finish after the user switches hosts; refresh
          // the same host that owned the generation request.
          settings: context.runtimeTargetSettings,
          worktreeId: context.worktreeId,
          worktreePath: context.worktreePath,
          connectionId: context.connectionId,
          pushTarget: worktreeMap.get(context.worktreeId)?.pushTarget,
          deps: {
            setGitStatus,
            updateWorktreeGitIdentity,
            setUpstreamStatus,
            fetchUpstreamStatus
          }
        })
      } catch (error) {
        console.warn('[SourceControl] post-generation git status refresh failed', error)
      }
    },
    [
      fetchUpstreamStatus,
      isFolder,
      setGitStatus,
      setUpstreamStatus,
      updateWorktreeGitIdentity,
      worktreeMap
    ]
  )

  useEffect(() => {
    if (!isBranchVisible || !activeRepo || isFolder) {
      return
    }

    // Why: reset to null so that effectiveBaseRef becomes falsy until the IPC
    // resolves.  This prevents the branch compare from firing with a stale
    // defaultBaseRef left over from a *different* repo (e.g. 'origin/master'
    // when the new repo uses 'origin/main'), which would cause a transient
    // "invalid-base" error every time the user switches between repos.
    setDefaultBaseRef(null)

    let stale = false
    void getRuntimeRepoBaseRefDefault(activeRepoSettings, activeRepo.id)
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
  }, [activeRepo, activeRepoSettings, isBranchVisible, isFolder])

  const normalizedWorktreeBaseRef = activeWorktree?.baseRef?.trim() || null
  const normalizedRepoBaseRef = activeRepo?.worktreeBaseRef?.trim() || null
  const baseRefOwnedByWorktree = normalizedWorktreeBaseRef !== null
  const pinnedBaseRef = normalizedWorktreeBaseRef ?? normalizedRepoBaseRef
  const hasUncommittedEntries = entries.length > 0

  const hostedReviewCreation =
    hostedReviewCreationState &&
    activeRepo?.id === hostedReviewCreationState.repoId &&
    activeWorktreeId === hostedReviewCreationState.worktreeId &&
    branchName === hostedReviewCreationState.branch
      ? hostedReviewCreationState.data
      : null
  const hostedReviewCreateProvider = resolveHostedReviewCreationProvider(
    hostedReviewCreation?.provider
  )
  const hostedReviewCreateCopy = localizedHostedReviewCopy(hostedReviewCreateProvider)
  const hostedReviewCacheKey =
    activeRepo && branchName
      ? getHostedReviewCacheKey(
          activeRepo.path,
          branchName,
          settings,
          activeRepo.id,
          activeRepo.connectionId,
          activeRepo.executionHostId
        )
      : null
  const hostedReviewEntry = hostedReviewCacheKey
    ? hostedReviewCache[hostedReviewCacheKey]
    : undefined
  const activePrCacheKey =
    activeRepo && branchName
      ? getGitHubPRCacheKey(
          activeRepo.path,
          activeRepo.id,
          branchName,
          settings,
          activeRepo.connectionId,
          activeRepo.executionHostId
        )
      : null
  const activePrFromQueue = activePrCacheKey ? (prCache[activePrCacheKey]?.data ?? null) : null
  const hostedReviewEntryData = hostedReviewEntry?.data ?? null
  const hostedReview: HostedReviewInfo | null = useMemo(() => {
    if (!hostedReviewCacheKey) {
      return null
    }
    if (activePrFromQueue) {
      return { provider: 'github', ...activePrFromQueue, status: activePrFromQueue.checksStatus }
    }
    return hostedReviewEntryData
  }, [activePrFromQueue, hostedReviewCacheKey, hostedReviewEntryData])
  const effectiveBaseRef = resolveSourceControlBaseRef({
    worktreeBaseRef: normalizedWorktreeBaseRef,
    reviewBaseRefName: hostedReview?.baseRefName,
    repoBaseRef: normalizedRepoBaseRef,
    defaultBaseRef
  })
  const pickerBaseRef = resolveSourceControlPickerBaseRef({
    pinnedBaseRef,
    effectiveBaseRef
  })

  const linkedGitHubPR = activeWorktree?.linkedPR ?? null
  const fallbackGitHubPRNumber = linkedGitHubPR == null ? (activePrFromQueue?.number ?? null) : null
  const linkedGitLabMR = activeWorktree?.linkedGitLabMR ?? null
  const linkedBitbucketPR = activeWorktree?.linkedBitbucketPR ?? null
  const linkedAzureDevOpsPR = activeWorktree?.linkedAzureDevOpsPR ?? null
  const linkedGiteaPR = activeWorktree?.linkedGiteaPR ?? null
  const shouldResolveHostedReviewCreation =
    isBranchVisible &&
    Boolean(activeRepo) &&
    !isFolder &&
    Boolean(branchName) &&
    branchName !== 'HEAD' &&
    Boolean(activeWorktreeId)
  const hostedReviewCreationRequestMatchesCurrent =
    hostedReviewCreationRequestState !== null &&
    activeRepo?.id === hostedReviewCreationRequestState.repoId &&
    activeWorktreeId === hostedReviewCreationRequestState.worktreeId &&
    branchName === hostedReviewCreationRequestState.branch
  const isHostedReviewCreationLoading =
    shouldResolveHostedReviewCreation &&
    hostedReviewCreationRequestMatchesCurrent &&
    hostedReviewCreationRequestState.status === 'loading' &&
    hostedReviewCreation === null &&
    hostedReview === null
  const hostedReviewCreationForHeader = useMemo(() => {
    if (hostedReviewCreation) {
      return hostedReviewCreation
    }
    if (!isHostedReviewCreationLoading) {
      return null
    }
    const provider = resolveProvisionalHostedReviewProvider({
      hostedReview,
      hostedReviewCreationState,
      activeRepoId: activeRepo?.id ?? null,
      linkedGitHubPR,
      fallbackGitHubPR: fallbackGitHubPRNumber,
      linkedGitLabMR,
      linkedBitbucketPR,
      linkedAzureDevOpsPR,
      linkedGiteaPR
    })
    return buildLoadingHostedReviewCreationEligibility(provider)
  }, [
    activeRepo?.id,
    fallbackGitHubPRNumber,
    hostedReview,
    hostedReviewCreation,
    hostedReviewCreationState,
    isHostedReviewCreationLoading,
    linkedAzureDevOpsPR,
    linkedBitbucketPR,
    linkedGitHubPR,
    linkedGitLabMR,
    linkedGiteaPR
  ])
  const hasLinkedHostedReview =
    (linkedGitHubPR ?? fallbackGitHubPRNumber) !== null ||
    linkedGitLabMR !== null ||
    linkedBitbucketPR !== null ||
    linkedAzureDevOpsPR !== null ||
    linkedGiteaPR !== null
  // Why: when activeRepo.connectionId is truthy, neither the SourceControl
  // effect below nor WorktreeCard.tsx fetches hostedReview for this branch,
  // so hostedReviewEntry would stay undefined forever and would permanently
  // block Publish Branch on SSH-backed worktrees with linked review metadata
  // and no upstream. Skip the loading state for those repos so the publish
  // gate doesn't latch.
  const isHostedReviewStateLoading =
    !activeRepo?.connectionId && hasLinkedHostedReview && hostedReviewEntry === undefined
  useEffect(() => {
    if (
      !isBranchVisible ||
      !activeRepo ||
      isFolder ||
      !branchName ||
      branchName === 'HEAD' ||
      !activeWorktreeId
    ) {
      return
    }
    // Why: the Source Control panel renders branch review status directly.
    // When a terminal checkout moves this worktree onto a new branch, fetch
    // immediately; carry a known PR number because branch lookup is lossy for
    // fork/deleted-head PRs.
    void fetchHostedReviewForBranch(activeRepo.path, branchName, {
      repoId: activeRepo.id,
      linkedGitHubPR,
      fallbackGitHubPR: fallbackGitHubPRNumber,
      linkedGitLabMR,
      linkedBitbucketPR,
      linkedAzureDevOpsPR,
      linkedGiteaPR,
      staleWhileRevalidate: true
    })
    // Why: the GitHub-specific cache powers grouping/check panels; keep that
    // refresh behind the coordinator so Source Control does not bypass pacing.
    enqueueGitHubPRRefresh(activeWorktreeId, 'swr', 30)
  }, [
    activeRepo,
    activeWorktreeId,
    branchName,
    enqueueGitHubPRRefresh,
    fetchHostedReviewForBranch,
    isBranchVisible,
    isFolder,
    linkedGitHubPR,
    fallbackGitHubPRNumber,
    linkedGitLabMR,
    linkedBitbucketPR,
    linkedAzureDevOpsPR,
    linkedGiteaPR
  ])

  // Why: eligibility is recomputed below, after prGenerating / isCreatingPr are
  // available, so the effect can pause refetches while a user-initiated PR flow
  // is in flight. AI generation runs `git fetch` + `git rebase`, which mutates
  // ahead/behind counts; without this guard the next refetch would return
  // canCreate:false (typically needs_push), flip primaryAction.kind off
  // create_pr, unmount the composer, and cancel the in-flight generation.

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
  const isGitHistoryVisible =
    !normalizedFilter && Boolean(activeWorktreeId && worktreePath && !isFolder)

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

  const treeRootsByArea = useMemo(
    () => ({
      staged: compactSourceControlTree(
        buildGitStatusSourceControlTree('staged', filteredGrouped.staged)
      ),
      unstaged: compactSourceControlTree(
        buildGitStatusSourceControlTree('unstaged', filteredGrouped.unstaged)
      ),
      untracked: compactSourceControlTree(
        buildGitStatusSourceControlTree('untracked', filteredGrouped.untracked)
      )
    }),
    [filteredGrouped]
  )

  const visibleTreeRowsByArea = useMemo(
    () => ({
      staged: flattenSourceControlTree(treeRootsByArea.staged, collapsedTreeDirs),
      unstaged: flattenSourceControlTree(treeRootsByArea.unstaged, collapsedTreeDirs),
      untracked: flattenSourceControlTree(treeRootsByArea.untracked, collapsedTreeDirs)
    }),
    [collapsedTreeDirs, treeRootsByArea]
  )

  const branchTreeRoots = useMemo(
    () => compactSourceControlTree(buildSourceControlTree('branch', filteredBranchEntries)),
    [filteredBranchEntries]
  )
  const visibleBranchTreeRows = useMemo(
    () => flattenSourceControlTree(branchTreeRoots, collapsedTreeDirs),
    [branchTreeRoots, collapsedTreeDirs]
  )

  const visibleSelectionEntries = useMemo(() => {
    if (sourceControlViewMode === 'list') {
      return flatEntries
    }

    const arr: FlatEntry[] = []
    for (const area of SECTION_ORDER) {
      if (collapsedSections.has(area)) {
        continue
      }
      for (const node of visibleTreeRowsByArea[area]) {
        if (node.type === 'file') {
          arr.push({ key: node.key, entry: node.entry, area: node.area })
        }
      }
    }
    return arr
  }, [collapsedSections, flatEntries, sourceControlViewMode, visibleTreeRowsByArea])

  const [isExecutingBulk, setIsExecutingBulk] = useState(false)
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
  const {
    sourceControlAiDiscoveryHostKey,
    resolvedCommitMessageAi,
    resolvedPrCreationDefaults,
    resolveConflictsComposerOpen,
    setResolveConflictsComposerOpen,
    commitGenerationDialogOpen,
    setCommitGenerationDialogOpen,
    pullRequestGenerationDialogOpen,
    setPullRequestGenerationDialogOpen,
    openCommitGenerationDialog,
    openPullRequestGenerationDialog,
    isLaunchingCommitFailureAgent,
    resolveConflictsPrompt,
    commitFailureRecoveryPrompt,
    getLaunchActionRecipe,
    saveLaunchActionDefault,
    handleResolveConflictsWithAI,
    handleFixCommitFailureWithAI,
    handleSaveCommitMessageGenerationDefaults,
    handleSavePullRequestGenerationDefaults,
    openSourceControlAiSettings
  } = useSourceControlAi({
    settings: activeRepoSettings,
    activeRepo: activeRepo ?? null,
    activeWorktreeId,
    activeConnectionId,
    activeGroupId,
    activeSourceControlLaunchPlatform,
    conflictOperation,
    unresolvedConflicts,
    stagedEntries: grouped.staged,
    worktreePath,
    commitMessage,
    commitError,
    updateSettings,
    updateRepo,
    openSettingsTarget,
    openSettingsPage
  })

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
    updateCommitDrafts((prev) => pruneRecord(prev))
    setCommitErrors((prev) => pruneRecord(prev))
    setRemoteActionErrors((prev) => pruneRecord(prev))
    setCommitInFlightByWorktree((prev) => pruneRecord(prev))
    setAbortOperationInFlightByWorktree((prev) => pruneRecord(prev))
    setGenerateInFlightByWorktree((prev) => pruneRecord(prev))
    setGenerateErrors((prev) => pruneRecord(prev))
    setCreatePrIntentInFlightByWorktree((prev) => pruneRecord(prev))
    setCreatePrIntentNotices((prev) => pruneRecord(prev))
    setGitHistoryByWorktree((prev) => pruneRecord(prev))
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
    for (const key of Object.keys(createPrIntentInFlightRef.current)) {
      if (!worktreeMap.has(key)) {
        delete createPrIntentInFlightRef.current[key]
        delete createPrIntentRunTokenRef.current[key]
      }
    }
    for (const key of Object.keys(gitHistoryRequestByWorktreeRef.current)) {
      if (!worktreeMap.has(key)) {
        delete gitHistoryRequestByWorktreeRef.current[key]
      }
    }
  }, [updateCommitDrafts, worktreeMap])

  useEffect(() => {
    // Why: users often finish merge/rebase conflicts in a terminal. Once git
    // status observes that operation end, the old Source Control failure banner
    // is stale and should not survive the successful external continue/abort.
    const previousConflictOperations = previousConflictOperationsRef.current
    setRemoteActionErrors((prev) =>
      clearRemoteActionErrorsForCompletedConflictOperations({
        remoteActionErrors: prev,
        previousConflictOperations,
        currentConflictOperations: conflictOperationsByWorktree
      })
    )
    previousConflictOperationsRef.current = conflictOperationsByWorktree
  }, [conflictOperationsByWorktree])

  // Why: the sidebar no longer uses key={activeWorktreeId} to force a full
  // remount on worktree switch (that caused an IPC storm on Windows).
  // Instead, reset worktree-specific local state here so the previous
  // worktree's UI state doesn't leak into the new one.
  useEffect(() => {
    setFilterExpanded(false)
    setCollapsedSections(createDefaultCollapsedSections())
    setCollapsedTreeDirs(new Set())
    setBaseRefDialogOpen(false)
    setPendingDiscard(null)
    setPendingDiffCommentsClear(null)
    setIsClearingDiffComments(false)
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
  const handleCommit = useCallback(
    async (
      messageOverride?: string,
      options?: {
        skipStagedSnapshotCheck?: boolean
        skipActiveConflictCheck?: boolean
        target?: SourceControlOperationTarget
      }
    ): Promise<boolean> => {
      const target =
        options?.target ??
        (activeWorktreeId && worktreePath
          ? {
              settings: activeRepoSettings,
              worktreeId: activeWorktreeId,
              worktreePath,
              connectionId: getConnectionId(activeWorktreeId) ?? undefined,
              pushTarget: activeWorktree?.pushTarget
            }
          : null)
      if (!target) {
        return false
      }
      const message = (messageOverride ?? commitMessage).trim()
      if (
        !message ||
        (!options?.skipStagedSnapshotCheck && grouped.staged.length === 0) ||
        (!options?.skipActiveConflictCheck && unresolvedConflicts.length > 0)
      ) {
        return false
      }

      if (commitInFlightRef.current[target.worktreeId]) {
        return false
      }
      commitInFlightRef.current[target.worktreeId] = true

      setCommitInFlightByWorktree((prev) => ({ ...prev, [target.worktreeId]: true }))
      setCommitErrors((prev) => ({ ...prev, [target.worktreeId]: null }))
      try {
        const commitResult = await commitRuntimeGit(
          {
            // Why: route the commit by the repo OWNER host, not the focused runtime.
            settings: target.settings,
            worktreeId: target.worktreeId,
            worktreePath: target.worktreePath,
            connectionId: target.connectionId
          },
          message
        )
        if (!commitResult.success) {
          setCommitErrors((prev) => ({
            ...prev,
            [target.worktreeId]: commitResult.error ?? 'Commit failed'
          }))
          return false
        }

        // Why: the textarea stays enabled during the in-flight commit (only the
        // button is disabled), so the user can keep typing after clicking Commit.
        // Unconditionally clearing the draft here would silently discard those
        // in-progress edits — the commit used the OLD `message` captured in this
        // closure, so the dropped text would never have been committed either.
        // Only clear when the current draft still matches what we committed.
        updateCommitDrafts((prev) => {
          const current = prev[target.worktreeId]
          if (current !== undefined && current.trim() !== message) {
            // User typed more after submit — preserve their in-progress edits.
            return prev
          }
          return writeCommitDraftForWorktree(prev, target.worktreeId, '')
        })
        setCommitErrors((prev) => ({ ...prev, [target.worktreeId]: null }))
        if (!options?.target) {
          void refreshActiveGitStatusAfterMutation()
        }
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
        if (!options?.target && effectiveBaseRef) {
          beginGitBranchCompareRequest(
            target.worktreeId,
            `${target.worktreeId}:${effectiveBaseRef}:${Date.now()}:post-commit`,
            effectiveBaseRef
          )
        }
        if (!options?.target) {
          void refreshBranchCompareRef.current()
          void refreshGitHistoryRef.current()
        }
        return true
      } catch (error) {
        setCommitErrors((prev) => ({
          ...prev,
          [target.worktreeId]: error instanceof Error ? error.message : 'Commit failed'
        }))
        return false
      } finally {
        setCommitInFlightByWorktree((prev) => ({ ...prev, [target.worktreeId]: false }))
        commitInFlightRef.current[target.worktreeId] = false
      }
    },
    [
      activeRepoSettings,
      activeWorktree?.pushTarget,
      activeWorktreeId,
      beginGitBranchCompareRequest,
      commitMessage,
      effectiveBaseRef,
      grouped.staged.length,
      refreshActiveGitStatusAfterMutation,
      updateCommitDrafts,
      unresolvedConflicts.length,
      worktreePath
    ]
  )

  const handleGenerate = useCallback(
    async (overrides?: RuntimeGenerateCommitMessageOverrides): Promise<void> => {
      if (!activeWorktreeId || !worktreePath || !activeCommitMessageGenerationKey) {
        return
      }
      if (generateInFlightRef.current[activeWorktreeId]) {
        return
      }
      if (!overrides?.sourceControlAiResolvedParams && resolvedCommitMessageAi?.ok !== true) {
        return
      }

      if (
        !overrides?.sourceControlAiResolvedParams &&
        resolvedCommitMessageAi?.ok === true &&
        isCustomAgentId(resolvedCommitMessageAi.value.params.agentId)
      ) {
        const command = resolvedCommitMessageAi.value.params.customAgentCommand?.trim() ?? ''
        if (!command) {
          setGenerateErrors((prev) => ({
            ...prev,
            [activeWorktreeId]:
              'Custom command is empty. Add one in Settings -> Git -> Source Control AI.'
          }))
          return
        }
      }

      generateInFlightRef.current[activeWorktreeId] = true
      const requestId = allocateCommitMessageGenerationRequestId()
      const connectionId = getConnectionId(activeWorktreeId) ?? undefined
      setCommitMessageGenerationRecord(
        activeCommitMessageGenerationKey,
        createRunningCommitMessageGenerationRecord({
          worktreeId: activeWorktreeId,
          worktreePath,
          connectionId,
          requestId,
          runtimeTargetSettings: activeRepoSettings
        })
      )
      setGenerateInFlightByWorktree((prev) => ({ ...prev, [activeWorktreeId]: true }))
      setGenerateErrors((prev) => ({ ...prev, [activeWorktreeId]: null }))
      try {
        const result = await generateRuntimeCommitMessage(
          {
            // Why: route generation by the repo OWNER host, not the focused runtime.
            settings: activeRepoSettings,
            worktreeId: activeWorktreeId,
            worktreePath,
            connectionId
          },
          overrides
        )

        if (!result.success) {
          // Why: cancellation is a deliberate user action, not a failure to
          // surface. Clear any prior error and stay quiet.
          if (result.canceled) {
            setGenerateErrors((prev) => ({ ...prev, [activeWorktreeId]: null }))
            updateCommitMessageGenerationRecord(activeCommitMessageGenerationKey, (record) =>
              resolveCommitMessageGenerationFailure({
                record,
                requestId,
                canceled: true,
                error: null
              })
            )
            return
          }
          setGenerateErrors((prev) => ({
            ...prev,
            [activeWorktreeId]: result.error
          }))
          updateCommitMessageGenerationRecord(activeCommitMessageGenerationKey, (record) =>
            resolveCommitMessageGenerationFailure({
              record,
              requestId,
              error: result.error
            })
          )
          return
        }

        updateCommitMessageGenerationRecord(activeCommitMessageGenerationKey, (record) =>
          resolveCommitMessageGenerationSuccess({
            record,
            requestId,
            message: result.message
          })
        )
        // Why: race protection — the user may have started typing into the
        // textarea while the agent was running. In that case we silently drop
        // the generated message rather than overwrite their in-progress edits.
        updateCommitDrafts((prev) => {
          const current = prev[activeWorktreeId]
          if (current && current.length > 0) {
            return prev
          }
          return writeCommitDraftForWorktree(prev, activeWorktreeId, result.message)
        })
        useAppStore.getState().recordFeatureInteraction('ai-commit-generation')
        setGenerateErrors((prev) => ({ ...prev, [activeWorktreeId]: null }))
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to generate commit message'
        setGenerateErrors((prev) => ({
          ...prev,
          [activeWorktreeId]: message
        }))
        updateCommitMessageGenerationRecord(activeCommitMessageGenerationKey, (record) =>
          resolveCommitMessageGenerationFailure({
            record,
            requestId,
            error: message
          })
        )
      } finally {
        setGenerateInFlightByWorktree((prev) => ({ ...prev, [activeWorktreeId]: false }))
        generateInFlightRef.current[activeWorktreeId] = false
      }
    },
    [
      activeCommitMessageGenerationKey,
      activeRepoSettings,
      activeWorktreeId,
      allocateCommitMessageGenerationRequestId,
      resolvedCommitMessageAi,
      setCommitMessageGenerationRecord,
      updateCommitDrafts,
      updateCommitMessageGenerationRecord,
      worktreePath
    ]
  )

  const handleGenerateCommitMessageClick = useCallback((): void => {
    if (
      hasConfiguredCommitMessageGenerationDefaults({ settings, repo: activeRepo ?? null }) &&
      resolvedCommitMessageAi?.ok
    ) {
      void handleGenerate({ sourceControlAiResolvedParams: resolvedCommitMessageAi.value.params })
      return
    }
    openCommitGenerationDialog()
  }, [activeRepo, handleGenerate, openCommitGenerationDialog, resolvedCommitMessageAi, settings])

  const generateCommitMessageForCreatePrIntent = useCallback(
    async (
      token: CreatePrIntentRunToken
    ): Promise<{
      ok: boolean
      message?: string
      reason?: 'settings' | 'failed' | 'canceled'
    }> => {
      if (
        !hasConfiguredCommitMessageGenerationDefaults({ settings, repo: activeRepo ?? null }) ||
        resolvedCommitMessageAi?.ok !== true
      ) {
        return { ok: false, reason: 'settings' }
      }
      if (isCustomAgentId(resolvedCommitMessageAi.value.params.agentId)) {
        const command = resolvedCommitMessageAi.value.params.customAgentCommand?.trim() ?? ''
        if (!command) {
          return { ok: false, reason: 'settings' }
        }
      }
      const target = getCreatePrIntentOperationTarget(token)
      if (generateInFlightRef.current[target.worktreeId]) {
        return { ok: false, reason: 'failed' }
      }

      generateInFlightRef.current[target.worktreeId] = true
      setGenerateInFlightByWorktree((prev) => ({ ...prev, [target.worktreeId]: true }))
      setGenerateErrors((prev) => ({ ...prev, [target.worktreeId]: null }))
      try {
        const result = await generateRuntimeCommitMessage(target, {
          sourceControlAiResolvedParams: resolvedCommitMessageAi.value.params
        })
        if (!result.success) {
          if (!result.canceled) {
            setGenerateErrors((prev) => ({ ...prev, [target.worktreeId]: result.error }))
          }
          return { ok: false, reason: result.canceled ? 'canceled' : 'failed' }
        }
        useAppStore.getState().recordFeatureInteraction('ai-commit-generation')
        setGenerateErrors((prev) => ({ ...prev, [target.worktreeId]: null }))
        return { ok: true, message: result.message }
      } catch (error) {
        setGenerateErrors((prev) => ({
          ...prev,
          [target.worktreeId]:
            error instanceof Error ? error.message : 'Failed to generate commit message'
        }))
        return { ok: false, reason: 'failed' }
      } finally {
        setGenerateInFlightByWorktree((prev) => ({ ...prev, [target.worktreeId]: false }))
        generateInFlightRef.current[target.worktreeId] = false
      }
    },
    [activeRepo, getCreatePrIntentOperationTarget, resolvedCommitMessageAi, settings]
  )

  const handleCancelGenerate = useCallback((): void => {
    if (!activeWorktreeId || !worktreePath || !activeCommitMessageGenerationKey) {
      return
    }
    if (!generateInFlightRef.current[activeWorktreeId]) {
      return
    }
    updateCommitMessageGenerationRecord(activeCommitMessageGenerationKey, (record) =>
      resolveCommitMessageGenerationCancel(record)
    )
    const connectionId = getConnectionId(activeWorktreeId) ?? undefined
    // Why: fire-and-forget — the in-flight generateCommitMessage promise
    // resolves with `{canceled: true}` once the kill propagates, which is
    // where the spinner is cleared. Awaiting here would just delay UI feedback.
    void cancelRuntimeGenerateCommitMessage({
      // Why: route the cancel by the repo OWNER host, not the focused runtime.
      settings: activeRepoSettings,
      worktreeId: activeWorktreeId,
      worktreePath,
      connectionId
    })
  }, [
    activeCommitMessageGenerationKey,
    activeRepoSettings,
    activeWorktreeId,
    updateCommitMessageGenerationRecord,
    worktreePath
  ])

  // Why: a single dispatcher for every remote-only action the split button or
  // chevron dropdown can trigger. Keeps the error-swallow pattern in one
  // place — store slices already surface actionable toasts, so additional
  // try/catch here would duplicate the notification.
  const runRemoteAction = useCallback(
    async (
      kind:
        | 'push'
        | 'force_push'
        | 'pull'
        | 'fast_forward'
        | 'sync'
        | 'fetch'
        | 'publish'
        | 'rebase',
      options?: {
        target?: SourceControlOperationTarget
        remoteStatus?: GitUpstreamStatus
        baseRef?: string | null
      }
    ): Promise<boolean> => {
      const target =
        options?.target ??
        (activeWorktreeId && worktreePath
          ? {
              settings: activeRepoSettings,
              worktreeId: activeWorktreeId,
              worktreePath,
              connectionId: getConnectionId(activeWorktreeId) ?? undefined,
              pushTarget: activeWorktree?.pushTarget
            }
          : null)
      if (!target) {
        return false
      }
      setRemoteActionErrors((prev) => ({ ...prev, [target.worktreeId]: null }))
      try {
        if (kind === 'publish') {
          await pushBranch(
            target.worktreeId,
            target.worktreePath,
            true,
            target.connectionId,
            target.pushTarget,
            { runtimeTargetSettings: target.settings }
          )
          return true
        }
        if (kind === 'push') {
          const forceWithLease = shouldForcePushWithLeaseForUpstream(
            options?.remoteStatus ?? remoteStatus
          )
          await pushBranch(
            target.worktreeId,
            target.worktreePath,
            false,
            target.connectionId,
            target.pushTarget,
            forceWithLease
              ? { forceWithLease: true, runtimeTargetSettings: target.settings }
              : { runtimeTargetSettings: target.settings }
          )
          return true
        }
        if (kind === 'force_push') {
          await pushBranch(
            target.worktreeId,
            target.worktreePath,
            false,
            target.connectionId,
            target.pushTarget,
            { forceWithLease: true, runtimeTargetSettings: target.settings }
          )
          return true
        }
        if (kind === 'pull') {
          await pullBranch(
            target.worktreeId,
            target.worktreePath,
            target.connectionId,
            target.pushTarget,
            {
              runtimeTargetSettings: target.settings
            }
          )
          return true
        }
        if (kind === 'fast_forward') {
          await fastForwardBranch(
            target.worktreeId,
            target.worktreePath,
            target.connectionId,
            target.pushTarget,
            { runtimeTargetSettings: target.settings }
          )
          return true
        }
        if (kind === 'fetch') {
          await fetchBranch(
            target.worktreeId,
            target.worktreePath,
            target.connectionId,
            target.pushTarget,
            {
              runtimeTargetSettings: target.settings
            }
          )
          return true
        }
        if (kind === 'rebase') {
          const baseRef = options?.baseRef ?? effectiveBaseRef
          if (!baseRef) {
            return false
          }
          await rebaseFromBase(
            target.worktreeId,
            target.worktreePath,
            baseRef,
            target.connectionId,
            target.pushTarget,
            { runtimeTargetSettings: target.settings }
          )
          return true
        }
        await syncBranch(
          target.worktreeId,
          target.worktreePath,
          target.connectionId,
          target.pushTarget,
          {
            runtimeTargetSettings: target.settings
          }
        )
        setRemoteActionErrors((prev) => ({ ...prev, [target.worktreeId]: null }))
        return true
      } catch (error) {
        // Why: remote action failures are surfaced by editor-slice actions to keep
        // one consistent toast path and avoid duplicate notifications in the UI.
        // Keep the latest failure inline too: dropdown-only actions like Fetch can
        // otherwise look like nothing happened once the menu closes.
        setRemoteActionErrors((prev) => ({
          ...prev,
          [target.worktreeId]: {
            kind,
            message: resolveRemoteActionError(kind, error)
          }
        }))
        return false
      } finally {
        if (!options?.target) {
          refreshSourceControlAfterRemoteAction({
            refreshGitStatus: refreshActiveGitStatusAfterMutation,
            refreshBranchCompare: refreshBranchCompareRef.current,
            refreshGitHistory: refreshGitHistoryRef.current
          })
        }
      }
    },
    [
      activeRepoSettings,
      activeWorktree?.pushTarget,
      activeWorktreeId,
      fetchBranch,
      fastForwardBranch,
      effectiveBaseRef,
      pullBranch,
      pushBranch,
      rebaseFromBase,
      refreshActiveGitStatusAfterMutation,
      remoteStatus,
      syncBranch,
      worktreePath
    ]
  )

  const handleAbortOperation = useCallback(
    async (requestedOperation: AbortConflictOperation): Promise<void> => {
      if (
        !activeWorktreeId ||
        !worktreePath ||
        conflictOperation !== requestedOperation ||
        isAbortingOperation
      ) {
        return
      }

      const isRebase = requestedOperation === 'rebase'
      const label = isRebase ? 'rebase' : 'merge'
      const title = isRebase ? 'Abort rebase?' : 'Abort merge?'
      const description = isRebase
        ? 'This cancels the rebase in progress and can discard conflict resolutions made during this rebase.'
        : 'This cancels the merge in progress and can discard conflict resolutions made during this merge.'
      const confirmed = await confirmAction({
        title,
        description,
        confirmLabel: `Abort ${label}`,
        confirmVariant: 'destructive'
      })
      if (!confirmed) {
        return
      }

      const connectionId = getConnectionId(activeWorktreeId) ?? undefined
      setAbortOperationInFlightByWorktree((prev) => ({ ...prev, [activeWorktreeId]: true }))
      setRemoteActionErrors((prev) => ({ ...prev, [activeWorktreeId]: null }))
      try {
        const context = {
          // Why: route the abort by the repo OWNER host, not the focused runtime.
          settings: activeRepoSettings,
          worktreeId: activeWorktreeId,
          worktreePath,
          connectionId
        }
        const abortGitOperation = isRebase ? abortRuntimeGitRebase : abortRuntimeGitMerge
        await abortGitOperation(context)
      } catch (error) {
        const message = error instanceof Error ? error.message : `Failed to abort ${label}`
        toast.error(
          translate(
            'auto.components.right.sidebar.SourceControl.f99560ab29',
            'Abort {{value0}} failed',
            { value0: label }
          ),
          { description: message }
        )
        setRemoteActionErrors((prev) => ({
          ...prev,
          [activeWorktreeId]: { kind: isRebase ? 'abort_rebase' : 'abort_merge', message }
        }))
      } finally {
        setAbortOperationInFlightByWorktree((prev) => ({ ...prev, [activeWorktreeId]: false }))
        refreshSourceControlAfterRemoteAction({
          refreshGitStatus: refreshActiveGitStatusAfterMutation,
          refreshBranchCompare: refreshBranchCompareRef.current,
          refreshGitHistory: refreshGitHistoryRef.current
        })
      }
    },
    [
      activeRepoSettings,
      activeWorktreeId,
      confirmAction,
      conflictOperation,
      isAbortingOperation,
      refreshActiveGitStatusAfterMutation,
      worktreePath
    ]
  )

  const handleAbortMerge = useCallback(async (): Promise<void> => {
    await handleAbortOperation('merge')
  }, [handleAbortOperation])

  const handleAbortRebase = useCallback(async (): Promise<void> => {
    await handleAbortOperation('rebase')
  }, [handleAbortOperation])

  const handleAbortOperationForConflict = useCallback(
    (operation: GitConflictOperation): void => {
      if (operation === 'merge') {
        void handleAbortMerge()
        return
      }
      if (operation === 'rebase') {
        void handleAbortRebase()
      }
    },
    [handleAbortMerge, handleAbortRebase]
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

  const handlePullRequestCreated = useCallback(
    async (result: CreatedHostedReview, context?: HostedReviewCreatedContext): Promise<void> => {
      const repoPath = context?.repoPath ?? activeRepo?.path
      const repoId = context?.repoId ?? activeRepo?.id
      const branch = context?.branch ?? branchName
      const worktreeId = context?.worktreeId ?? activeWorktreeId ?? null
      const openChecks = context?.openChecks ?? true
      if (!repoPath || !repoId || !branch) {
        return
      }
      const copy = localizedHostedReviewCopy(
        resolveSupportedHostedReviewCopyProvider(result.provider)
      )
      if (openChecks) {
        setRightSidebarOpen(true)
        setRightSidebarTab('checks')
      }
      try {
        if (worktreeId && result.provider === 'github') {
          await updateWorktreeMeta(worktreeId, { linkedPR: result.number })
        }
        if (worktreeId && result.provider === 'gitlab') {
          await updateWorktreeMeta(worktreeId, { linkedGitLabMR: result.number })
        }
        if (worktreeId && result.provider === 'azure-devops') {
          await updateWorktreeMeta(worktreeId, { linkedAzureDevOpsPR: result.number })
        }
        if (worktreeId && result.provider === 'gitea') {
          await updateWorktreeMeta(worktreeId, { linkedGiteaPR: result.number })
        }
        const linkedReviewNumbers = {
          linkedGitHubPR: result.provider === 'github' ? result.number : linkedGitHubPR,
          fallbackGitHubPR: fallbackGitHubPRNumber,
          linkedGitLabMR: result.provider === 'gitlab' ? result.number : linkedGitLabMR,
          linkedBitbucketPR,
          linkedAzureDevOpsPR:
            result.provider === 'azure-devops' ? result.number : linkedAzureDevOpsPR,
          linkedGiteaPR: result.provider === 'gitea' ? result.number : linkedGiteaPR
        }
        if (result.provider === 'gitlab') {
          await fetchHostedReviewForBranch(repoPath, branch, {
            force: true,
            repoId,
            ...linkedReviewNumbers
          })
          return
        }
        if (result.provider !== 'github') {
          await fetchHostedReviewForBranch(repoPath, branch, {
            force: true,
            repoId,
            ...linkedReviewNumbers
          })
          return
        }
        await Promise.all([
          fetchHostedReviewForBranch(repoPath, branch, {
            force: true,
            repoId,
            ...linkedReviewNumbers
          }),
          fetchPRForBranch(repoPath, branch, {
            force: true,
            repoId,
            worktreeId: worktreeId ?? undefined,
            linkedPRNumber: result.number
          })
        ])
      } catch {
        toast.warning(
          translate(
            'auto.components.right.sidebar.SourceControl.0453ca3a9a',
            '{{value0}} created, but Orca could not refresh it yet.',
            { value0: copy.titleLabel }
          ),
          {
            action: {
              label: translate(
                'auto.components.right.sidebar.SourceControl.812cb992ee',
                'Open on {{value0}}',
                { value0: copy.providerName }
              ),
              onClick: () => window.api.shell.openUrl(result.url)
            }
          }
        )
      }
    },
    [
      activeRepo,
      activeWorktreeId,
      branchName,
      fallbackGitHubPRNumber,
      fetchHostedReviewForBranch,
      fetchPRForBranch,
      linkedAzureDevOpsPR,
      linkedBitbucketPR,
      linkedGiteaPR,
      linkedGitHubPR,
      linkedGitLabMR,
      setRightSidebarOpen,
      setRightSidebarTab,
      updateWorktreeMeta
    ]
  )

  const openHostedReviewInChecks = useCallback(() => {
    setRightSidebarOpen(true)
    setRightSidebarTab('checks')
  }, [setRightSidebarOpen, setRightSidebarTab])

  const handleBranchChangedByPullRequestGeneration = useCallback(async (): Promise<void> => {
    // Why: AI PR detail generation may rebase before summarizing; if HEAD moved,
    // refresh status before letting the user submit the generated draft.
    await refreshActiveGitStatusAfterMutation()
  }, [refreshActiveGitStatusAfterMutation])

  const handleGeneratePullRequestFieldsForActive = useCallback(
    async (
      fields: PullRequestGenerationFields,
      fieldRevisions: PullRequestFieldRevisions,
      overrides?: RuntimeGeneratePullRequestFieldsOverrides
    ): Promise<void> => {
      if (!activeRepo || !activePullRequestGenerationKey || !worktreePath || !branchName) {
        return
      }
      const generationKey = activePullRequestGenerationKey
      if (
        useAppStore.getState().pullRequestGenerationRecords[generationKey]?.status === 'running'
      ) {
        return
      }
      const requestId = allocatePullRequestGenerationRequestId()
      const context: PullRequestGenerationContext = {
        worktreeId: activeWorktreeId,
        worktreePath,
        connectionId: getConnectionId(activeWorktreeId) ?? undefined,
        requestId,
        repoId: activeRepo.id,
        branch: branchName,
        runtimeTargetSettings: activeRepoSettings
      }
      const seed = { ...fields }
      // Why: SourceControl can unmount on tab switches; persisting the running
      // record lets the embedded PR composer resume when the user returns.
      setPullRequestGenerationRecord(
        generationKey,
        createRunningPullRequestGenerationRecord(context, seed, fieldRevisions)
      )

      try {
        const result = await generateRuntimePullRequestFields(
          {
            // Why: route generation by the repo OWNER host, not the focused runtime.
            settings: context.runtimeTargetSettings,
            worktreeId: context.worktreeId,
            worktreePath: context.worktreePath,
            connectionId: context.connectionId
          },
          {
            base: stripBaseRef(seed.base.trim()),
            title: seed.title,
            body: seed.body,
            draft: seed.draft,
            provider: hostedReviewCreateProvider,
            useTemplate: resolvedPrCreationDefaults.useTemplate
          },
          overrides
        )
        if (result.branchChangedByPreparation) {
          await refreshGitStatusAfterPullRequestGeneration(context)
        }
        if (result.success) {
          useAppStore.getState().recordFeatureInteraction('ai-pr-generation')
        }
        updatePullRequestGenerationRecord(generationKey, (record) => {
          if (!result.success) {
            return resolvePullRequestGenerationFailure({
              record,
              requestId,
              canceled: result.canceled,
              error: result.canceled ? null : result.error
            })
          }
          if (!record) {
            return null
          }
          return resolvePullRequestGenerationSuccess({
            record,
            requestId,
            result: {
              base: stripBaseRef(result.fields.base),
              title: result.fields.title,
              body: result.fields.body,
              draft: result.fields.draft
            }
          })
        })
      } catch (error) {
        updatePullRequestGenerationRecord(generationKey, (record) =>
          resolvePullRequestGenerationFailure({
            record,
            requestId,
            error:
              error instanceof Error ? error.message : 'Failed to generate pull request details'
          })
        )
      }
    },
    [
      activePullRequestGenerationKey,
      activeRepo,
      activeRepoSettings,
      activeWorktreeId,
      allocatePullRequestGenerationRequestId,
      branchName,
      hostedReviewCreateProvider,
      refreshGitStatusAfterPullRequestGeneration,
      resolvedPrCreationDefaults.useTemplate,
      setPullRequestGenerationRecord,
      updatePullRequestGenerationRecord,
      worktreePath
    ]
  )

  const handleCancelGeneratePullRequestFieldsForActive = useCallback((): void => {
    if (!activePullRequestGenerationKey) {
      return
    }
    const record = prGenerationRecords[activePullRequestGenerationKey]
    if (!record || record.status !== 'running') {
      return
    }
    const generationKey = activePullRequestGenerationKey
    updatePullRequestGenerationRecord(generationKey, (current) => {
      if (!current || current.context.requestId !== record.context.requestId) {
        return null
      }
      return resolvePullRequestGenerationCancel(current)
    })
    void cancelRuntimeGeneratePullRequestFields({
      // Why: the user can switch hosts while generation runs; cancel the
      // original request owner instead of the current focused host.
      settings: record.context.runtimeTargetSettings,
      worktreeId: record.context.worktreeId,
      worktreePath: record.context.worktreePath,
      connectionId: record.context.connectionId
    }).catch((error) => {
      updatePullRequestGenerationRecord(generationKey, (current) => {
        if (!current || current.context.requestId !== record.context.requestId) {
          return null
        }
        return {
          ...current,
          status: 'failed',
          error: error instanceof Error ? error.message : 'Failed to stop pull request generation',
          hydrated: false
        }
      })
    })
  }, [activePullRequestGenerationKey, prGenerationRecords, updatePullRequestGenerationRecord])

  const {
    aiGenerationEnabled: prAiGenerationEnabled,
    base: prBase,
    setBase: setPrBase,
    title: prTitle,
    setTitle: setPrTitle,
    body: prBody,
    setBody: setPrBody,
    draft: prDraft,
    setDraft: setPrDraft,
    baseQuery: prBaseQuery,
    setBaseQuery: setPrBaseQuery,
    baseResults: prBaseResults,
    setBaseResults: setPrBaseResults,
    baseSearchError: prBaseSearchError,
    generating: prGenerating,
    generateError: prGenerateError,
    generateDisabled: prGenerateDisabled,
    generateDisabledReason: prGenerateDisabledReason,
    handleGenerate: handleGeneratePullRequestFields,
    handleCancelGenerate: handleCancelGeneratePullRequestFields,
    applyGeneratedFields: applyGeneratedPullRequestFields,
    initializedFromEligibility: pullRequestFieldsInitialized
  } = useCreatePullRequestDialogFields({
    open: hostedReviewCreation?.canCreate === true,
    repoId: activeRepo?.id ?? '',
    worktreeId: activeWorktreeId,
    worktreePath: worktreePath ?? '',
    branch: branchName,
    eligibility: hostedReviewCreation,
    repo: activeRepo ?? null,
    settings: activeRepoSettings,
    submitting: isCreatingPr,
    prCreationDefaults: resolvedPrCreationDefaults,
    onBranchChangedByGeneration: handleBranchChangedByPullRequestGeneration,
    generation: {
      generating: activePullRequestGenerationRecord?.status === 'running',
      generateError: activePullRequestGenerationRecord?.error ?? null,
      onGenerate: (fields, fieldRevisions, overrides) => {
        void handleGeneratePullRequestFieldsForActive(fields, fieldRevisions, overrides)
      },
      onCancelGenerate: handleCancelGeneratePullRequestFieldsForActive
    }
  })

  const handleGeneratePullRequestFieldsClick = useCallback((): void => {
    if (
      hasConfiguredSourceControlTextGenerationDefaults({
        actionId: 'pullRequest',
        settings,
        repo: activeRepo ?? null
      })
    ) {
      void handleGeneratePullRequestFields()
      return
    }
    openPullRequestGenerationDialog()
  }, [activeRepo, handleGeneratePullRequestFields, openPullRequestGenerationDialog, settings])

  useEffect(() => {
    // Why: on Source Control remount, the PR fields hook seeds eligibility
    // defaults in an effect; hydrating before that effect runs gets overwritten.
    if (
      !activePullRequestGenerationKey ||
      !activePullRequestGenerationRecord ||
      activePullRequestGenerationRecord.status !== 'succeeded' ||
      !activePullRequestGenerationRecord.result ||
      activePullRequestGenerationRecord.hydrated ||
      !pullRequestFieldsInitialized
    ) {
      return
    }
    if (
      !shouldHydratePullRequestGenerationResult({
        record: activePullRequestGenerationRecord
      })
    ) {
      return
    }
    const result = activePullRequestGenerationRecord.result
    applyGeneratedPullRequestFields(result, activePullRequestGenerationRecord.seedFieldRevisions)
    updatePullRequestGenerationRecord(activePullRequestGenerationKey, (record) => {
      if (
        !record ||
        record.context.requestId !== activePullRequestGenerationRecord.context.requestId
      ) {
        return null
      }
      return {
        ...record,
        hydrated: true
      }
    })
  }, [
    activePullRequestGenerationKey,
    activePullRequestGenerationRecord,
    applyGeneratedPullRequestFields,
    pullRequestFieldsInitialized,
    updatePullRequestGenerationRecord
  ])

  useEffect(() => {
    // Why: direct commit-message generation can finish after Source Control
    // unmounts; the store record lets the remounted textarea consume it once.
    if (
      !activeCommitMessageGenerationKey ||
      !activeWorktreeId ||
      !activeCommitMessageGenerationRecord ||
      activeCommitMessageGenerationRecord.status !== 'succeeded' ||
      !activeCommitMessageGenerationRecord.message ||
      activeCommitMessageGenerationRecord.hydrated
    ) {
      return
    }
    updateCommitDrafts((prev) => {
      const current = prev[activeWorktreeId]
      return current && current.length > 0
        ? prev
        : writeCommitDraftForWorktree(
            prev,
            activeWorktreeId,
            activeCommitMessageGenerationRecord.message ?? ''
          )
    })
    updateCommitMessageGenerationRecord(activeCommitMessageGenerationKey, (record) =>
      markCommitMessageGenerationHydrated(record)
    )
  }, [
    activeCommitMessageGenerationKey,
    activeCommitMessageGenerationRecord,
    activeWorktreeId,
    updateCommitDrafts,
    updateCommitMessageGenerationRecord
  ])

  useEffect(() => {
    if (!isBranchVisible || !activeRepo || isFolder || !branchName || !activeWorktreeId) {
      setHostedReviewCreationState(null)
      setHostedReviewCreationRequestState(null)
      return
    }
    // Why: skip refetches while the user's PR flow is mid-flight. AI generation,
    // Create PR intent, and submission can all perturb ahead/behind or dirty
    // state temporarily. Recomputing eligibility mid-flow can tear down the
    // composer or rotate dropdown hints before the final refresh restores truth.
    if (prGenerating || isCreatingPr || isCreatePrIntentInFlight) {
      setHostedReviewCreationRequestState(null)
      return
    }
    let stale = false
    setHostedReviewCreationRequestState({
      repoId: activeRepo.id,
      worktreeId: activeWorktreeId,
      branch: branchName,
      status: 'loading'
    })
    void getHostedReviewCreationEligibility({
      repoPath: activeRepo.path,
      repoId: activeRepo.id,
      ...(worktreePath ? { worktreePath } : {}),
      branch: branchName,
      base: effectiveBaseRef ?? null,
      hasUncommittedChanges: hasUncommittedEntries,
      hasUpstream: remoteStatus?.hasUpstream,
      ahead: remoteStatus?.ahead,
      behind: remoteStatus?.behind,
      linkedGitHubPR,
      fallbackGitHubPR: fallbackGitHubPRNumber,
      linkedGitLabMR,
      linkedBitbucketPR,
      linkedAzureDevOpsPR,
      linkedGiteaPR
    })
      .then((result) => {
        if (!stale) {
          setHostedReviewCreationState({
            repoId: activeRepo.id,
            worktreeId: activeWorktreeId,
            branch: branchName,
            data: result
          })
          setHostedReviewCreationRequestState(null)
        }
      })
      .catch((error) => {
        console.warn('[SourceControl] hosted review creation eligibility failed', error)
        if (!stale) {
          setHostedReviewCreationState(null)
          setHostedReviewCreationRequestState({
            repoId: activeRepo.id,
            worktreeId: activeWorktreeId,
            branch: branchName,
            status: 'failed'
          })
        }
      })
    return () => {
      stale = true
    }
  }, [
    activeRepo,
    branchName,
    effectiveBaseRef,
    getHostedReviewCreationEligibility,
    hasUncommittedEntries,
    setHostedReviewCreationRequestState,
    isBranchVisible,
    isCreatingPr,
    isCreatePrIntentInFlight,
    isFolder,
    linkedGitHubPR,
    fallbackGitHubPRNumber,
    linkedGitLabMR,
    linkedBitbucketPR,
    linkedAzureDevOpsPR,
    linkedGiteaPR,
    prGenerating,
    remoteStatus?.ahead,
    remoteStatus?.behind,
    remoteStatus?.hasUpstream,
    activeWorktreeId,
    worktreePath
  ])

  const handleCreatePullRequest = useCallback(async (): Promise<void> => {
    if (
      !activeRepo ||
      !activeWorktreeId ||
      !worktreePath ||
      !hostedReviewCreation?.canCreate ||
      prGenerating ||
      createPrInFlightRef.current[activeWorktreeId]
    ) {
      return
    }

    const base = stripBaseRef(prBase).trim()
    const title = prTitle.trim()

    if (!title) {
      setCreatePrIntentNoticeForWorktree(activeWorktreeId, {
        tone: 'destructive',
        message: translate(
          'auto.components.right.sidebar.SourceControl.f3a8b2c1d0e5',
          'Enter a {{value0}} title.',
          { value0: hostedReviewCreateCopy.reviewLabel }
        )
      })
      return
    }

    if (!base || stripBaseRef(base).toLowerCase() === stripBaseRef(branchName).toLowerCase()) {
      setCreatePrIntentNoticeForWorktree(activeWorktreeId, {
        tone: 'destructive',
        message: translate(
          'auto.components.right.sidebar.SourceControl.ae743199cd',
          'Choose a different base branch before creating a {{value0}}.',
          { value0: hostedReviewCreateCopy.reviewLabel }
        )
      })
      return
    }

    createPrInFlightRef.current[activeWorktreeId] = true
    setCreatePrInFlightByWorktree((prev) => ({ ...prev, [activeWorktreeId]: true }))
    setCreatePrIntentNoticeForWorktree(activeWorktreeId, null)
    try {
      const result = await createHostedReview(activeRepo.path, {
        repoId: activeRepo.id,
        provider: hostedReviewCreateProvider,
        base,
        head: normalizeHostedReviewHeadRef(branchName),
        title,
        body: prBody,
        draft: prDraft,
        worktreePath,
        useTemplate: resolvedPrCreationDefaults.useTemplate
      })

      if (result.ok) {
        setCreatePrIntentNoticeForWorktree(activeWorktreeId, null)
        await handlePullRequestCreated({
          provider: hostedReviewCreateProvider,
          number: result.number,
          url: result.url
        })
        if (resolvedPrCreationDefaults.openAfterCreate) {
          window.api.shell.openUrl(result.url)
        }
        return
      }

      if (result.existingReview?.url) {
        const number = result.existingReview.number
        toast.success(
          number
            ? translate(
                'auto.components.right.sidebar.SourceControl.eef5446523',
                '{{value0}} #{{value1}} is already open',
                { value0: hostedReviewCreateCopy.titleLabel, value1: number }
              )
            : translate(
                'auto.components.right.sidebar.SourceControl.d6fb1df5fe',
                '{{value0}} is already open',
                { value0: hostedReviewCreateCopy.titleLabel }
              ),
          {
            action: {
              label: translate(
                'auto.components.right.sidebar.SourceControl.812cb992ee',
                'Open on {{value0}}',
                { value0: hostedReviewCreateCopy.providerName }
              ),
              onClick: () => window.api.shell.openUrl(result.existingReview!.url)
            }
          }
        )
        if (number) {
          setCreatePrIntentNoticeForWorktree(activeWorktreeId, null)
          await handlePullRequestCreated({
            provider: hostedReviewCreateProvider,
            number,
            url: result.existingReview.url
          })
          return
        }
      }

      setCreatePrIntentNoticeForWorktree(activeWorktreeId, {
        tone: 'destructive',
        message: result.error
      })
    } catch (error) {
      setCreatePrIntentNoticeForWorktree(activeWorktreeId, {
        tone: 'destructive',
        message:
          error instanceof Error
            ? error.message
            : translate(
                'auto.components.right.sidebar.SourceControl.e2b7a1c0d9f4',
                'Failed to create {{value0}}',
                { value0: hostedReviewCreateCopy.reviewLabel }
              )
      })
    } finally {
      createPrInFlightRef.current[activeWorktreeId] = false
      setCreatePrInFlightByWorktree((prev) => ({ ...prev, [activeWorktreeId]: false }))
    }
  }, [
    activeRepo,
    activeWorktreeId,
    branchName,
    createHostedReview,
    handlePullRequestCreated,
    hostedReviewCreation,
    hostedReviewCreateCopy.providerName,
    hostedReviewCreateCopy.reviewLabel,
    hostedReviewCreateCopy.titleLabel,
    hostedReviewCreateProvider,
    prBase,
    prBody,
    prDraft,
    prGenerating,
    prTitle,
    resolvedPrCreationDefaults.openAfterCreate,
    resolvedPrCreationDefaults.useTemplate,
    setCreatePrIntentNoticeForWorktree,
    worktreePath
  ])

  const createHostedReviewForCreatePrIntent = useCallback(
    async (
      token: CreatePrIntentRunToken,
      eligibility: HostedReviewCreationEligibility
    ): Promise<boolean> => {
      if (!activeRepo || !token.branch || !eligibility.canCreate) {
        return false
      }

      const base = stripBaseRef(
        eligibility.defaultBaseRef ?? effectiveBaseRef ?? prBase ?? ''
      ).trim()
      if (!base || stripBaseRef(base).toLowerCase() === stripBaseRef(token.branch).toLowerCase()) {
        setCreatePrIntentNoticeForWorktree(token.worktreeId, {
          tone: 'destructive',
          message: translate(
            'auto.components.right.sidebar.SourceControl.ae743199cd',
            'Choose a different base branch before creating a {{value0}}.',
            { value0: hostedReviewCreateCopy.reviewLabel }
          )
        })
        return false
      }

      const fallbackTitle =
        eligibility.title?.trim() ||
        humanizeBranchSlug(stripBaseRef(token.branch).split('/').pop()?.replace(/_/g, '-') ?? '') ||
        stripBaseRef(token.branch)
      let fields = {
        base,
        title: fallbackTitle,
        body: eligibility.body ?? prBody,
        draft: resolvedPrCreationDefaults.draft
      }

      if (
        hasConfiguredSourceControlTextGenerationDefaults({
          actionId: 'pullRequest',
          settings,
          repo: activeRepo
        })
      ) {
        setCreatePrIntentNoticeForWorktree(token.worktreeId, {
          tone: 'muted',
          message: translate(
            'auto.components.right.sidebar.SourceControl.createPrIntentGeneratingDetails',
            'Generating review details…'
          )
        })
        const target = getCreatePrIntentOperationTarget(token)
        try {
          const generated = await generateRuntimePullRequestFields(target, {
            ...fields,
            provider: eligibility.provider,
            useTemplate: resolvedPrCreationDefaults.useTemplate
          })
          if (generated.branchChangedByPreparation) {
            setCreatePrIntentNoticeForWorktree(token.worktreeId, {
              tone: 'muted',
              message: translate(
                'auto.components.right.sidebar.SourceControl.createPrIntentBranchChangedDuringDetails',
                'Branch changed while generating review details. Retry Create PR.'
              )
            })
            return false
          }
          if (generated.success) {
            fields = {
              // Why: Create PR intent auto-submits; generated details should
              // not retarget the review without user confirmation.
              base: fields.base,
              title: generated.fields.title.trim() || fields.title,
              body: generated.fields.body,
              draft: generated.fields.draft
            }
          }
        } catch (error) {
          console.warn('[SourceControl] Create PR intent detail generation failed', error)
        }
      }

      if (
        !createPrIntentRunStillOwnsWorktree(token) ||
        createPrIntentActiveTargetConflicts(token)
      ) {
        return false
      }
      const createPrIntentIsForeground = (): boolean =>
        createPrIntentRunTokenMatches(token, createPrIntentCurrentTargetRef.current)

      const title = fields.title.trim()
      if (!title) {
        setCreatePrIntentNoticeForWorktree(token.worktreeId, {
          tone: 'destructive',
          message: translate(
            'auto.components.right.sidebar.SourceControl.f3a8b2c1d0e5',
            'Enter a {{value0}} title.',
            { value0: hostedReviewCreateCopy.reviewLabel }
          )
        })
        return false
      }

      setCreatePrIntentNoticeForWorktree(token.worktreeId, {
        tone: 'muted',
        message: translate(
          'auto.components.right.sidebar.SourceControl.createPrIntentCreatingReview',
          'Creating review…'
        )
      })
      createPrInFlightRef.current[token.worktreeId] = true
      setCreatePrInFlightByWorktree((prev) => ({ ...prev, [token.worktreeId]: true }))
      try {
        const result = await createHostedReview(activeRepo.path, {
          repoId: activeRepo.id,
          provider: eligibility.provider,
          base: fields.base,
          head: normalizeHostedReviewHeadRef(token.branch),
          title,
          body: fields.body,
          draft: fields.draft,
          worktreePath: token.worktreePath,
          useTemplate: resolvedPrCreationDefaults.useTemplate
        })

        if (result.ok) {
          const openChecks = createPrIntentIsForeground()
          await handlePullRequestCreated(
            {
              provider: eligibility.provider,
              number: result.number,
              url: result.url
            },
            {
              repoPath: activeRepo.path,
              repoId: activeRepo.id,
              branch: token.branch,
              worktreeId: token.worktreeId,
              openChecks
            }
          )
          if (openChecks && resolvedPrCreationDefaults.openAfterCreate) {
            window.api.shell.openUrl(result.url)
          }
          setCreatePrIntentNoticeForWorktree(token.worktreeId, null)
          return true
        }

        if (result.existingReview?.number && result.existingReview.url) {
          const openChecks = createPrIntentIsForeground()
          await handlePullRequestCreated(
            {
              provider: eligibility.provider,
              number: result.existingReview.number,
              url: result.existingReview.url
            },
            {
              repoPath: activeRepo.path,
              repoId: activeRepo.id,
              branch: token.branch,
              worktreeId: token.worktreeId,
              openChecks
            }
          )
          setCreatePrIntentNoticeForWorktree(token.worktreeId, null)
          return true
        }

        setCreatePrIntentNoticeForWorktree(token.worktreeId, {
          tone: 'destructive',
          message: result.error
        })
        return false
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : translate(
                'auto.components.right.sidebar.SourceControl.e2b7a1c0d9f4',
                'Failed to create {{value0}}',
                { value0: hostedReviewCreateCopy.reviewLabel }
              )
        setCreatePrIntentNoticeForWorktree(token.worktreeId, {
          tone: 'destructive',
          message
        })
        return false
      } finally {
        createPrInFlightRef.current[token.worktreeId] = false
        setCreatePrInFlightByWorktree((prev) => ({ ...prev, [token.worktreeId]: false }))
      }
    },
    [
      activeRepo,
      createHostedReview,
      effectiveBaseRef,
      createPrIntentActiveTargetConflicts,
      createPrIntentRunStillOwnsWorktree,
      getCreatePrIntentOperationTarget,
      handlePullRequestCreated,
      hostedReviewCreateCopy.reviewLabel,
      prBase,
      prBody,
      resolvedPrCreationDefaults.draft,
      resolvedPrCreationDefaults.openAfterCreate,
      resolvedPrCreationDefaults.useTemplate,
      setCreatePrIntentNoticeForWorktree,
      settings
    ]
  )

  const refreshBranchCompareForCreatePrIntent = useCallback(
    async (token: CreatePrIntentRunToken): Promise<number | undefined> => {
      if (!effectiveBaseRef) {
        return undefined
      }
      const requestKey = `${token.worktreeId}:${effectiveBaseRef}:${Date.now()}:create-pr-intent`
      beginGitBranchCompareRequest(token.worktreeId, requestKey, effectiveBaseRef)
      const result = await getRuntimeGitBranchCompare(
        {
          // Why: the intent flow may continue after a worktree switch; use the
          // token's original host target, not whatever branch is focused later.
          settings: activeRepoSettings,
          worktreeId: token.worktreeId,
          worktreePath: token.worktreePath,
          connectionId: getConnectionId(token.worktreeId) ?? undefined
        },
        effectiveBaseRef
      )
      setGitBranchCompareResult(token.worktreeId, requestKey, result)
      return result.summary.status === 'ready' ? (result.summary.commitsAhead ?? 0) : undefined
    },
    [activeRepoSettings, beginGitBranchCompareRequest, effectiveBaseRef, setGitBranchCompareResult]
  )

  const readHostedReviewCreationEligibilityForIntent = useCallback(
    async ({
      token,
      hasUncommittedChanges,
      upstreamStatus
    }: {
      token: CreatePrIntentRunToken
      hasUncommittedChanges: boolean
      upstreamStatus?: NonNullable<typeof remoteStatus>
    }): Promise<HostedReviewCreationEligibility | null> => {
      if (!activeRepo || !token.branch) {
        return null
      }
      const result = await getHostedReviewCreationEligibility({
        repoPath: activeRepo.path,
        repoId: activeRepo.id,
        worktreePath: token.worktreePath,
        branch: token.branch,
        base: effectiveBaseRef ?? null,
        hasUncommittedChanges,
        hasUpstream: upstreamStatus?.hasUpstream,
        ahead: upstreamStatus?.ahead,
        behind: upstreamStatus?.behind,
        linkedGitHubPR,
        fallbackGitHubPR: fallbackGitHubPRNumber,
        linkedGitLabMR,
        linkedBitbucketPR,
        linkedAzureDevOpsPR,
        linkedGiteaPR
      })
      setHostedReviewCreationState({
        repoId: activeRepo.id,
        worktreeId: token.worktreeId,
        branch: token.branch,
        data: result
      })
      return result
    },
    [
      activeRepo,
      effectiveBaseRef,
      fallbackGitHubPRNumber,
      getHostedReviewCreationEligibility,
      linkedAzureDevOpsPR,
      linkedBitbucketPR,
      linkedGiteaPR,
      linkedGitHubPR,
      linkedGitLabMR
    ]
  )

  const refreshGitStatusForCreatePrIntent = useCallback(
    async (token: CreatePrIntentRunToken) => {
      if (isFolder) {
        return null
      }
      const target = getCreatePrIntentOperationTarget(token)
      return await refreshGitStatusForWorktreeStrict({
        // Why: Create PR intent can finish in the background after navigation,
        // but branch-safety checks must inspect the worktree that started it.
        settings: target.settings,
        worktreeId: target.worktreeId,
        worktreePath: target.worktreePath,
        connectionId: target.connectionId,
        pushTarget: target.pushTarget,
        deps: {
          setGitStatus,
          updateWorktreeGitIdentity,
          setUpstreamStatus
        }
      })
    },
    [
      getCreatePrIntentOperationTarget,
      isFolder,
      setGitStatus,
      setUpstreamStatus,
      updateWorktreeGitIdentity
    ]
  )

  const runCreatePrIntent = useCallback(async (): Promise<void> => {
    if (
      !activeRepo ||
      !activeWorktreeId ||
      !worktreePath ||
      !branchName ||
      isExecutingBulk ||
      isCommitting ||
      isGenerating ||
      isRemoteOperationActive ||
      prGenerating ||
      isCreatingPr ||
      createPrIntentInFlightRef.current[activeWorktreeId]
    ) {
      return
    }

    const token = createCreatePrIntentRunToken({
      repoId: activeRepo.id,
      worktreeId: activeWorktreeId,
      worktreePath,
      branch: branchName
    })
    const operationTarget = getCreatePrIntentOperationTarget(token)
    const runIsCurrent = (): boolean =>
      createPrIntentRunStillOwnsWorktree(token) && !createPrIntentActiveTargetConflicts(token)
    let abortedByStaleTarget = false
    const abortIfStale = (): boolean => {
      if (runIsCurrent()) {
        return false
      }
      abortedByStaleTarget = true
      return true
    }
    createPrIntentRunTokenRef.current[token.worktreeId] = token
    createPrIntentInFlightRef.current[token.worktreeId] = true
    setCreatePrIntentInFlightByWorktree((prev) => ({ ...prev, [token.worktreeId]: true }))
    setCreatePrIntentNoticeForWorktree(token.worktreeId, {
      tone: 'muted',
      message: translate(
        'auto.components.right.sidebar.SourceControl.d37e68f61d',
        'Preparing branch for review…'
      )
    })

    try {
      let latestStatusEntries = entries
      let latestUpstreamStatus = remoteStatus
      const refreshIntentSnapshot = async (): Promise<boolean> => {
        const refreshed = await refreshGitStatusForCreatePrIntent(token)
        if (!refreshed) {
          return false
        }
        // Why: terminal checkouts are observed by this strict status snapshot
        // before React updates createPrIntentCurrentTargetRef. Stop before the
        // intent flow stages, commits, or pushes on a different branch.
        if (!createPrIntentGitStatusMatchesToken(token, refreshed.status)) {
          abortedByStaleTarget = true
          return false
        }
        if (abortIfStale()) {
          return false
        }
        latestStatusEntries = refreshed.status.entries
        latestUpstreamStatus = refreshed.upstreamStatus
        return true
      }
      const stageLatestIntentPaths = async (): Promise<boolean> => {
        const stagePaths = getCreatePrIntentStagePaths({
          unstaged: latestStatusEntries.filter((entry) => entry.area === 'unstaged'),
          untracked: latestStatusEntries.filter((entry) => entry.area === 'untracked')
        })
        if (stagePaths.length === 0) {
          return true
        }
        setIsExecutingBulk(true)
        try {
          await bulkStageRuntimeGitPaths(operationTarget, stagePaths)
        } finally {
          setIsExecutingBulk(false)
        }
        if (abortIfStale()) {
          return false
        }
        return refreshIntentSnapshot()
      }

      if (!(await refreshIntentSnapshot())) {
        return
      }

      if (!(await stageLatestIntentPaths())) {
        return
      }

      const stagedEntries = latestStatusEntries.filter((entry) => entry.area === 'staged')
      if (stagedEntries.length > 0) {
        let message = readCommitDraftForWorktree(commitDraftsRef.current, token.worktreeId).trim()
        if (!message) {
          setCreatePrIntentNoticeForWorktree(token.worktreeId, {
            tone: 'muted',
            message: translate(
              'auto.components.right.sidebar.SourceControl.8d8f5c6c94',
              'Generating commit message…'
            )
          })
          const generated = await generateCommitMessageForCreatePrIntent(token)
          if (abortIfStale()) {
            return
          }
          if (!generated.ok || !generated.message) {
            setCreatePrIntentNoticeForWorktree(token.worktreeId, {
              tone: generated.reason === 'settings' ? 'muted' : 'destructive',
              message: translate(
                generated.reason === 'settings'
                  ? 'auto.components.right.sidebar.SourceControl.createPrIntentConfigureAi'
                  : 'auto.components.right.sidebar.SourceControl.createPrIntentGenerateFailed',
                generated.reason === 'settings'
                  ? 'Add a commit message or configure Source Control AI settings.'
                  : 'Could not generate a commit message. Add one and retry.'
              ),
              action: generated.reason === 'settings' ? 'settings' : undefined
            })
            return
          }
          const draftAfterGeneration = readCommitDraftForWorktree(
            commitDraftsRef.current,
            token.worktreeId
          ).trim()
          if (draftAfterGeneration) {
            setCreatePrIntentNoticeForWorktree(token.worktreeId, {
              tone: 'muted',
              message: translate(
                'auto.components.right.sidebar.SourceControl.fda060d6ce',
                'Review the commit message, then retry Create PR.'
              )
            })
            return
          }
          message = generated.message
          updateCommitDrafts((prev) => writeCommitDraftForWorktree(prev, token.worktreeId, message))
        }

        setCreatePrIntentNoticeForWorktree(token.worktreeId, {
          tone: 'muted',
          message: translate(
            'auto.components.right.sidebar.SourceControl.b75cb1fd0c',
            'Committing changes…'
          )
        })
        const committed = await handleCommit(message, {
          skipStagedSnapshotCheck: true,
          skipActiveConflictCheck: true,
          target: operationTarget
        })
        if (abortIfStale()) {
          return
        }
        if (!committed) {
          // Why: pre-commit/lint hooks may rewrite tracked files before
          // failing. Re-stage those safe hook outputs so retrying Create PR
          // does not strand changes outside the intended all-in commit.
          if (await refreshIntentSnapshot()) {
            await stageLatestIntentPaths()
          }
          if (abortIfStale()) {
            return
          }
          setCreatePrIntentNoticeForWorktree(token.worktreeId, {
            tone: 'destructive',
            message: translate(
              'auto.components.right.sidebar.SourceControl.createPrIntentCommitFailed',
              'Could not commit changes. Fix the issue, then retry Create PR.'
            )
          })
          return
        }
        if (!(await refreshIntentSnapshot())) {
          return
        }
      }

      const branchAhead = await refreshBranchCompareForCreatePrIntent(token)
      if (abortIfStale()) {
        return
      }
      let eligibility = await readHostedReviewCreationEligibilityForIntent({
        token,
        hasUncommittedChanges: latestStatusEntries.length > 0,
        upstreamStatus: latestUpstreamStatus
      })
      if (abortIfStale() || !eligibility) {
        return
      }
      if (eligibility.canCreate) {
        await createHostedReviewForCreatePrIntent(token, eligibility)
        if (abortIfStale()) {
          return
        }
        return
      }
      if (eligibility.blockedReason === 'existing_review') {
        setCreatePrIntentNoticeForWorktree(token.worktreeId, null)
        return
      }

      const remoteStep = resolveCreatePrIntentRemoteStep({
        upstreamStatus: latestUpstreamStatus,
        hostedReviewCreation: eligibility,
        branchCommitsAhead: branchAhead,
        hasCurrentBranch: Boolean(token.branch)
      })
      if (remoteStep === 'blocked' || remoteStep === 'none') {
        setCreatePrIntentNoticeForWorktree(token.worktreeId, {
          tone: 'muted',
          message: translate(
            eligibility.blockedReason === 'needs_sync'
              ? 'auto.components.right.sidebar.SourceControl.createPrIntentNeedsSync'
              : 'auto.components.right.sidebar.SourceControl.createPrIntentBranchNotReady',
            eligibility.blockedReason === 'needs_sync'
              ? 'Sync this branch before creating a review.'
              : 'Branch is not ready to create a review yet.'
          )
        })
        return
      }

      setCreatePrIntentNoticeForWorktree(token.worktreeId, {
        tone: 'muted',
        message: translate(
          remoteStep === 'publish'
            ? 'auto.components.right.sidebar.SourceControl.createPrIntentPublishing'
            : remoteStep === 'force_push'
              ? 'auto.components.right.sidebar.SourceControl.createPrIntentForcePushing'
              : 'auto.components.right.sidebar.SourceControl.createPrIntentPushing',
          remoteStep === 'publish'
            ? 'Publishing branch…'
            : remoteStep === 'force_push'
              ? 'Force pushing with lease…'
              : 'Pushing commits…'
        )
      })
      const remoteOk = await runRemoteAction(remoteStep, {
        target: operationTarget,
        remoteStatus: latestUpstreamStatus,
        baseRef: effectiveBaseRef
      })
      if (abortIfStale()) {
        return
      }
      if (!remoteOk) {
        setCreatePrIntentNoticeForWorktree(token.worktreeId, {
          tone: 'destructive',
          message: translate(
            'auto.components.right.sidebar.SourceControl.createPrIntentRemoteFailed',
            'Could not update the remote branch. Retry Create PR.'
          )
        })
        return
      }
      if (!(await refreshIntentSnapshot())) {
        return
      }
      await refreshBranchCompareForCreatePrIntent(token)
      if (abortIfStale()) {
        return
      }
      eligibility = await readHostedReviewCreationEligibilityForIntent({
        token,
        hasUncommittedChanges: latestStatusEntries.length > 0,
        upstreamStatus: latestUpstreamStatus
      })
      if (abortIfStale()) {
        return
      }
      if (eligibility?.canCreate) {
        await createHostedReviewForCreatePrIntent(token, eligibility)
        if (abortIfStale()) {
          return
        }
        return
      }
      setCreatePrIntentNoticeForWorktree(token.worktreeId, {
        tone: 'muted',
        message: translate(
          'auto.components.right.sidebar.SourceControl.995c5e67ec',
          'Review setup needs attention.'
        )
      })
    } catch (error) {
      console.warn('[SourceControl] Create PR intent failed', error)
      if (!abortIfStale()) {
        setCreatePrIntentNoticeForWorktree(token.worktreeId, {
          tone: 'destructive',
          message: translate(
            'auto.components.right.sidebar.SourceControl.d7492cafce',
            'Could not refresh Source Control. Retry Create PR.'
          )
        })
      }
    } finally {
      if (createPrIntentRunTokenRef.current[token.worktreeId] === token) {
        createPrIntentInFlightRef.current[token.worktreeId] = false
        createPrIntentRunTokenRef.current[token.worktreeId] = null
        if (abortedByStaleTarget) {
          setCreatePrIntentNoticeForWorktree(token.worktreeId, null)
        }
        setCreatePrIntentInFlightByWorktree((prev) => ({
          ...prev,
          [token.worktreeId]: false
        }))
      }
    }
  }, [
    activeRepo,
    activeWorktreeId,
    branchName,
    createPrIntentActiveTargetConflicts,
    createPrIntentRunStillOwnsWorktree,
    createHostedReviewForCreatePrIntent,
    effectiveBaseRef,
    entries,
    generateCommitMessageForCreatePrIntent,
    getCreatePrIntentOperationTarget,
    handleCommit,
    isCommitting,
    isCreatingPr,
    isExecutingBulk,
    isGenerating,
    isRemoteOperationActive,
    prGenerating,
    readHostedReviewCreationEligibilityForIntent,
    refreshGitStatusForCreatePrIntent,
    refreshBranchCompareForCreatePrIntent,
    remoteStatus,
    runRemoteAction,
    setCreatePrIntentNoticeForWorktree,
    updateCommitDrafts,
    worktreePath
  ])

  const hasUnstagedChanges = grouped.unstaged.length > 0 || grouped.untracked.length > 0
  const hasStageableChanges = hasUnstagedChanges
  const hasPartiallyStagedChanges = useMemo(() => {
    if (grouped.staged.length === 0 || grouped.unstaged.length === 0) {
      return false
    }
    const unstagedPaths = new Set(grouped.unstaged.map((entry) => entry.path))
    return grouped.staged.some((entry) => unstagedPaths.has(entry.path))
  }, [grouped.staged, grouped.unstaged])

  const primaryAction: PrimaryAction = useMemo(() => {
    return resolveCommitAreaPrimaryAction({
      stagedCount: grouped.staged.length,
      hasUnstagedChanges,
      hasStageableChanges,
      hasPartiallyStagedChanges,
      hasMessage: commitMessage.trim().length > 0,
      hasUnresolvedConflicts: unresolvedConflicts.length > 0,
      isCommitting,
      isRemoteOperationActive: isRemoteOperationActive || isAbortingOperation,
      upstreamStatus: remoteStatus,
      prState: hostedReview?.state ?? null,
      isPRStateLoading: isHostedReviewStateLoading,
      inFlightRemoteOpKind,
      hostedReviewCreation,
      branchCommitsAhead:
        branchSummary?.status === 'ready' ? (branchSummary.commitsAhead ?? 0) : undefined,
      hasCurrentBranch: Boolean(branchName),
      canPushLinkedReviewWithoutUpstream:
        Boolean(activeWorktree?.pushTarget) || remoteStatus?.hasConfiguredPushTarget === true,
      isPrIntentInFlight: isCreatePrIntentInFlight
    })
  }, [
    commitMessage,
    grouped.staged.length,
    hasStageableChanges,
    hasUnstagedChanges,
    hasPartiallyStagedChanges,
    isCommitting,
    isAbortingOperation,
    isRemoteOperationActive,
    inFlightRemoteOpKind,
    hostedReviewCreation,
    isHostedReviewStateLoading,
    hostedReview?.state,
    activeWorktree?.pushTarget,
    isCreatePrIntentInFlight,
    branchSummary?.commitsAhead,
    branchSummary?.status,
    branchName,
    remoteStatus,
    unresolvedConflicts.length
  ])

  const createPrHeaderAction: PrimaryAction | null = useMemo(() => {
    const action = resolveCreatePrHeaderAction({
      stagedCount: grouped.staged.length,
      hasUnstagedChanges,
      hasStageableChanges,
      hasPartiallyStagedChanges,
      hasMessage: commitMessage.trim().length > 0,
      hasUnresolvedConflicts: unresolvedConflicts.length > 0,
      isCommitting,
      isRemoteOperationActive: isRemoteOperationActive || isAbortingOperation,
      upstreamStatus: remoteStatus,
      prState: hostedReview?.state ?? null,
      isPRStateLoading: isHostedReviewStateLoading,
      inFlightRemoteOpKind,
      hostedReviewCreation: hostedReviewCreationForHeader,
      isHostedReviewCreationLoading:
        isHostedReviewCreationLoading && hostedReviewCreationForHeader !== null,
      branchCommitsAhead:
        branchSummary?.status === 'ready' ? (branchSummary.commitsAhead ?? 0) : undefined,
      hasCurrentBranch: Boolean(branchName),
      isPrIntentInFlight: isCreatePrIntentInFlight
    })
    return isCreatingPr && action?.kind === 'create_pr'
      ? {
          ...action,
          title: translate(
            'auto.components.right.sidebar.SourceControl.fe5bd1a610',
            'Creating {{value0}}...',
            { value0: hostedReviewCreateCopy.reviewLabel }
          ),
          disabled: true
        }
      : action
  }, [
    branchName,
    branchSummary?.commitsAhead,
    branchSummary?.status,
    commitMessage,
    grouped.staged.length,
    hasPartiallyStagedChanges,
    hasStageableChanges,
    hasUnstagedChanges,
    hostedReview?.state,
    hostedReviewCreationForHeader,
    hostedReviewCreateCopy.reviewLabel,
    inFlightRemoteOpKind,
    isAbortingOperation,
    isCommitting,
    isCreatePrIntentInFlight,
    isCreatingPr,
    isHostedReviewCreationLoading,
    isHostedReviewStateLoading,
    isRemoteOperationActive,
    remoteStatus,
    unresolvedConflicts.length
  ])
  const directCreatePrAction =
    createPrHeaderAction?.kind === 'create_pr' &&
    hostedReviewCreation?.canCreate === true &&
    (!createPrHeaderAction.disabled || isCreatingPr)
      ? createPrHeaderAction
      : null
  const visibleCreatePrHeaderAction = resolveVisibleCreatePrHeaderAction({
    createPrHeaderAction
  })

  const dropdownItems: DropdownEntry[] = useMemo(
    () =>
      resolveDropdownItems({
        stagedCount: grouped.staged.length,
        hasUnstagedChanges,
        hasStageableChanges,
        hasPartiallyStagedChanges,
        hasMessage: commitMessage.trim().length > 0,
        hasUnresolvedConflicts: unresolvedConflicts.length > 0,
        isCommitting,
        isRemoteOperationActive: isRemoteOperationActive || isAbortingOperation,
        conflictOperation,
        upstreamStatus: remoteStatus,
        prState: hostedReview?.state ?? null,
        isPRStateLoading: isHostedReviewStateLoading,
        inFlightRemoteOpKind,
        hostedReviewCreation,
        isPullRequestOperationActive: prGenerating || isCreatingPr || isCreatePrIntentInFlight,
        branchCommitsAhead:
          branchSummary?.status === 'ready' ? (branchSummary.commitsAhead ?? 0) : undefined,
        hasCurrentBranch: Boolean(branchName),
        canPushLinkedReviewWithoutUpstream:
          Boolean(activeWorktree?.pushTarget) || remoteStatus?.hasConfiguredPushTarget === true,
        rebaseBaseRef: effectiveBaseRef
      }),
    [
      commitMessage,
      grouped.staged.length,
      hasStageableChanges,
      hasUnstagedChanges,
      hasPartiallyStagedChanges,
      isCommitting,
      conflictOperation,
      isAbortingOperation,
      isRemoteOperationActive,
      inFlightRemoteOpKind,
      hostedReviewCreation,
      isCreatingPr,
      isCreatePrIntentInFlight,
      isHostedReviewStateLoading,
      hostedReview?.state,
      prGenerating,
      activeWorktree?.pushTarget,
      branchSummary?.commitsAhead,
      branchSummary?.status,
      branchName,
      effectiveBaseRef,
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
      if (prGenerating || isCreatingPr || isCreatePrIntentInFlight) {
        return
      }
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
        case 'abort_merge':
          void handleAbortMerge()
          return
        case 'abort_rebase':
          void handleAbortRebase()
          return
        case 'create_pr':
          void handleCreatePullRequest()
          return
        case 'push_create_pr':
          void runCreatePrIntent()
          return
        case 'push':
        case 'force_push':
        case 'pull':
        case 'fast_forward':
        case 'sync':
        case 'fetch':
        case 'publish':
        case 'rebase_base':
          void runRemoteAction(kind === 'rebase_base' ? 'rebase' : kind)
      }
    },
    [
      handleCommit,
      handleCreatePullRequest,
      handleAbortMerge,
      handleAbortRebase,
      isCreatingPr,
      isCreatePrIntentInFlight,
      prGenerating,
      runCreatePrIntent,
      runCompoundCommitAction,
      runRemoteAction
    ]
  )

  // Why: modifier-click should keep the current pane intact by opening the
  // selected Source Control file in a fresh split to the right.
  const resolveSplitTargetGroupId = useCallback(
    (event?: SourceControlRowOpenEvent): string | undefined => {
      if (!event || !activeWorktreeId || !isSourceControlSplitOpenModifier(event, isMac)) {
        return undefined
      }
      const sourceGroupId =
        activeGroupIdByWorktree[activeWorktreeId] ?? groupsByWorktree[activeWorktreeId]?.[0]?.id
      if (!sourceGroupId) {
        return undefined
      }
      return createEmptySplitGroup(activeWorktreeId, sourceGroupId, 'right') ?? undefined
    },
    [activeGroupIdByWorktree, activeWorktreeId, createEmptySplitGroup, groupsByWorktree, isMac]
  )

  // Why: a stable string signature keeps this selector referentially stable so
  // the panel only re-renders when the active editor file (or its diff source)
  // actually changes. Gated on the visible tab being an editor so the highlight
  // clears when the user switches to a terminal or browser surface.
  const activeOpenFileSignature = useAppStore((s) => {
    if (!activeWorktreeId) {
      return null
    }
    if (s.activeTabTypeByWorktree?.[activeWorktreeId] !== 'editor') {
      return null
    }
    const activeFileId = s.activeFileIdByWorktree?.[activeWorktreeId]
    if (!activeFileId) {
      return null
    }
    const activeFile = s.openFiles?.find(
      (file) => file.id === activeFileId && file.worktreeId === activeWorktreeId
    )
    if (!activeFile) {
      return null
    }
    return buildActiveOpenFileSignature(activeFile.diffSource, activeFile.relativePath)
  })

  const activeOpenAvailableRowKeys = useMemo(() => {
    const keys = new Set<string>()
    for (const entry of visibleSelectionEntries) {
      keys.add(entry.key)
    }
    return keys
  }, [visibleSelectionEntries])

  const activeOpenRowKeys = useMemo(
    () => buildActiveOpenRowKeys(activeOpenFileSignature, activeOpenAvailableRowKeys),
    [activeOpenAvailableRowKeys, activeOpenFileSignature]
  )

  const handleOpenDiff = useCallback(
    (entry: GitStatusEntry, event?: SourceControlRowOpenEvent) => {
      if (!activeWorktreeId || !worktreePath) {
        return
      }
      const targetGroupId = resolveSplitTargetGroupId(event)
      const openAsPreview = shouldOpenSourceControlRowAsPreview(event, targetGroupId)
      if (entry.conflictKind && entry.conflictStatus) {
        if (entry.conflictStatus === 'unresolved') {
          trackConflictPath(activeWorktreeId, entry.path, entry.conflictKind)
        }
        openConflictFile(activeWorktreeId, worktreePath, entry, detectLanguage(entry.path), {
          targetGroupId,
          preview: openAsPreview
        })
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
        openFile(
          {
            filePath,
            relativePath: entry.path,
            worktreeId: activeWorktreeId,
            language,
            mode: 'edit'
          },
          { targetGroupId, preview: openAsPreview }
        )
        setEditorViewMode(filePath, 'changes')
        return
      }
      openDiff(activeWorktreeId, filePath, entry.path, language, entry.area === 'staged', {
        targetGroupId,
        preview: openAsPreview
      })
    },
    [
      activeWorktreeId,
      worktreePath,
      resolveSplitTargetGroupId,
      trackConflictPath,
      openConflictFile,
      openDiff,
      openFile,
      setEditorViewMode
    ]
  )

  const { selectedKeys, handleSelect, handleContextMenu, clearSelection } =
    useSourceControlSelection({
      flatEntries: visibleSelectionEntries,
      onOpenDiff: handleOpenDiff,
      shouldOpenAsSplit: (event) => isSourceControlSplitOpenModifier(event, isMac),
      containerRef: sourceControlRef
    })

  // clear selection on list/tree presentation change
  useEffect(() => {
    clearSelection()
  }, [sourceControlViewMode, clearSelection])

  const handleToggleSourceControlViewMode = useCallback(() => {
    if (!settings) {
      return
    }
    updateSettings({
      sourceControlViewMode: getNextSourceControlViewMode(sourceControlViewMode)
    })
  }, [settings, sourceControlViewMode, updateSettings])

  // Clear selection on worktree or tab change
  useEffect(() => {
    clearSelection()
  }, [activeWorktreeId, rightSidebarTab, clearSelection])

  const flatEntriesByKey = useMemo(
    () => new Map(visibleSelectionEntries.map((entry) => [entry.key, entry])),
    [visibleSelectionEntries]
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
        .filter((entry) => isStageableStatusEntry(entry.entry))
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
          // Why: route staging by the repo OWNER host, not the focused runtime.
          settings: activeRepoSettings,
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
    activeRepoSettings,
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
          // Why: route unstaging by the repo OWNER host, not the focused runtime.
          settings: activeRepoSettings,
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
    activeRepoSettings,
    worktreePath,
    bulkUnstagePaths,
    clearSelection,
    activeWorktreeId,
    refreshActiveGitStatusAfterMutation
  ])

  const handleStageAllPaths = useCallback(
    async (paths: readonly string[]) => {
      if (!worktreePath || isExecutingBulk || paths.length === 0) {
        return
      }
      setIsExecutingBulk(true)
      try {
        const connectionId = getConnectionId(activeWorktreeId ?? null) ?? undefined
        await bulkStageRuntimeGitPaths(
          {
            // Why: route staging by the repo OWNER host, not the focused runtime.
            settings: activeRepoSettings,
            worktreeId: activeWorktreeId,
            worktreePath,
            connectionId
          },
          [...paths]
        )
        await refreshActiveGitStatusAfterMutation()
        clearSelection()
      } finally {
        setIsExecutingBulk(false)
      }
    },
    [
      activeRepoSettings,
      activeWorktreeId,
      clearSelection,
      isExecutingBulk,
      refreshActiveGitStatusAfterMutation,
      worktreePath
    ]
  )

  const handleUnstagePaths = useCallback(
    async (paths: readonly string[]) => {
      if (!worktreePath || isExecutingBulk || paths.length === 0) {
        return
      }
      setIsExecutingBulk(true)
      try {
        const connectionId = getConnectionId(activeWorktreeId ?? null) ?? undefined
        await bulkUnstageRuntimeGitPaths(
          {
            // Why: route unstaging by the repo OWNER host, not the focused runtime.
            settings: activeRepoSettings,
            worktreeId: activeWorktreeId,
            worktreePath,
            connectionId
          },
          [...paths]
        )
        await refreshActiveGitStatusAfterMutation()
        clearSelection()
      } finally {
        setIsExecutingBulk(false)
      }
    },
    [
      activeRepoSettings,
      activeWorktreeId,
      clearSelection,
      isExecutingBulk,
      refreshActiveGitStatusAfterMutation,
      worktreePath
    ]
  )

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
            // Why: route staging by the repo OWNER host, not the focused runtime.
            settings: activeRepoSettings,
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
      activeRepoSettings,
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
          // Why: route staging by the repo OWNER host, not the focused runtime.
          settings: activeRepoSettings,
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
    activeRepoSettings,
    worktreePath,
    isExecutingBulk,
    grouped,
    activeWorktreeId,
    clearSelection,
    refreshActiveGitStatusAfterMutation
  ])

  // Why: PrimaryActionKind is narrowed to the single-action kinds the
  // primary can emit ('commit' | 'stage' | 'push' | 'pull' | 'sync' |
  // 'publish' | 'create_pr') — compound commit_* kinds are dropdown-only. An exhaustive
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
      case 'create_pr':
        handleActionInvoke(primaryAction.kind)
        return
      case 'create_pr_intent':
        void runCreatePrIntent()
    }
  }, [handleActionInvoke, handleStageAllPrimary, primaryAction.kind, runCreatePrIntent])

  const handleCreatePrHeaderClick = useCallback((): void => {
    if (!createPrHeaderAction || createPrHeaderAction.disabled) {
      return
    }
    if (createPrHeaderAction.kind === 'create_pr') {
      void handleCreatePullRequest()
      return
    }
    if (createPrHeaderAction.kind === 'create_pr_intent') {
      void runCreatePrIntent()
    }
  }, [createPrHeaderAction, handleCreatePullRequest, runCreatePrIntent])

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
          // Why: route unstaging by the repo OWNER host, not the focused runtime.
          settings: activeRepoSettings,
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
    activeRepoSettings,
    worktreePath,
    grouped.staged,
    activeWorktreeId,
    isExecutingBulk,
    clearSelection,
    refreshActiveGitStatusAfterMutation
  ])

  const branchCompareInFlightRef = useRef(false)
  const branchCompareRerunRef = useRef(false)
  const branchCompareRunPromiseRef = useRef<Promise<void> | null>(null)
  const refreshBranchCompareRef = useRef<() => Promise<void>>(async () => {})

  const runBranchCompare = useCallback(async () => {
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
      beginGitBranchCompareRequest(activeWorktreeId, requestKey, effectiveBaseRef, {
        preserveExistingSummary: true
      })
    }

    try {
      const connectionId = getConnectionId(activeWorktreeId ?? null) ?? undefined
      const result = await getRuntimeGitBranchCompare(
        {
          // Why: route the branch compare by the repo OWNER host, not the focused runtime.
          settings: activeRepoSettings,
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
    activeRepoSettings,
    activeWorktreeId,
    beginGitBranchCompareRequest,
    branchName,
    effectiveBaseRef,
    isFolder,
    setGitBranchCompareResult,
    worktreePath
  ])

  const refreshBranchCompare = useCallback(async () => {
    if (branchCompareInFlightRef.current) {
      branchCompareRerunRef.current = true
      return branchCompareRunPromiseRef.current ?? undefined
    }

    branchCompareInFlightRef.current = true
    const runPromise = (async (): Promise<void> => {
      // Why: branch compare shells out to git on a timer and can exceed the
      // 5s poll interval on large repos. Keep one compare chain in flight and
      // collapse skipped ticks into one trailing refresh instead of stacking
      // subprocesses while preserving the await contract for direct callers.
      try {
        await runBranchCompare()
      } finally {
        branchCompareInFlightRef.current = false
        if (branchCompareRerunRef.current) {
          branchCompareRerunRef.current = false
          await refreshBranchCompareRef.current()
        }
      }
    })()
    branchCompareRunPromiseRef.current = runPromise
    try {
      await runPromise
    } finally {
      if (branchCompareRunPromiseRef.current === runPromise) {
        branchCompareRunPromiseRef.current = null
      }
    }
  }, [runBranchCompare])

  refreshBranchCompareRef.current = refreshBranchCompare

  const refreshGitHistory = useCallback(async (): Promise<void> => {
    if (
      !activeWorktreeId ||
      !worktreePath ||
      isFolder ||
      !isBranchVisible ||
      !isGitHistoryExpanded ||
      !isGitHistoryVisible
    ) {
      return
    }

    const worktreeId = activeWorktreeId
    const requestId = gitHistoryRequestSeqRef.current + 1
    gitHistoryRequestSeqRef.current = requestId
    gitHistoryRequestByWorktreeRef.current[worktreeId] = requestId
    setGitHistoryByWorktree((prev) => {
      const previous = prev[worktreeId]
      return {
        ...prev,
        [worktreeId]: previous?.result
          ? { status: 'refreshing', result: previous.result }
          : { status: 'loading' }
      }
    })

    try {
      const connectionId = getConnectionId(worktreeId) ?? undefined
      const result = await getRuntimeGitHistory(
        {
          // Why: route the history read by the repo OWNER host, not the focused runtime.
          settings: activeRepoSettings,
          worktreeId,
          worktreePath,
          connectionId
        },
        { limit: 50, baseRef: effectiveBaseRef }
      )
      if (gitHistoryRequestByWorktreeRef.current[worktreeId] !== requestId) {
        return
      }
      setGitHistoryByWorktree((prev) => ({ ...prev, [worktreeId]: { status: 'ready', result } }))
    } catch (error) {
      if (gitHistoryRequestByWorktreeRef.current[worktreeId] !== requestId) {
        return
      }
      const message = error instanceof Error ? error.message : 'Failed to load commits'
      setGitHistoryByWorktree((prev) => {
        const previous = prev[worktreeId]
        return {
          ...prev,
          [worktreeId]: previous?.result
            ? { status: 'error', result: previous.result, error: message }
            : { status: 'error', error: message }
        }
      })
    }
  }, [
    activeRepoSettings,
    activeWorktreeId,
    effectiveBaseRef,
    isBranchVisible,
    isFolder,
    isGitHistoryExpanded,
    isGitHistoryVisible,
    worktreePath
  ])

  const refreshGitHistoryRef = useRef(refreshGitHistory)
  refreshGitHistoryRef.current = refreshGitHistory

  useEffect(() => {
    if (!activeWorktreeId || !worktreePath || !isBranchVisible || !effectiveBaseRef || isFolder) {
      return
    }

    // Why: branch compare shells out to git every tick. The panel only needs
    // background freshness while Orca is visible; hidden-window time should not
    // burn subprocess work or timer wakeups.
    return installWindowVisibilityInterval({
      run: () => void refreshBranchCompareRef.current(),
      intervalMs: BRANCH_REFRESH_INTERVAL_MS
    })
  }, [activeWorktreeId, effectiveBaseRef, isBranchVisible, isFolder, worktreePath])

  useEffect(() => {
    // Why: history shells out to git. Defer the first load until the user
    // expands Commits so source control stays cheap for large/remote repos.
    if (!isBranchVisible || !isGitHistoryExpanded || !isGitHistoryVisible) {
      return
    }
    void refreshGitHistoryRef.current()
  }, [
    activeWorktreeId,
    effectiveBaseRef,
    isBranchVisible,
    isFolder,
    isGitHistoryExpanded,
    isGitHistoryVisible,
    worktreePath
  ])

  useEffect(() => {
    // Why: gate on isBranchVisible so we don't spawn git processes while the
    // sidebar is closed. Store-slice remote operations refresh upstream-status
    // on success anyway, so the user's first sidebar open will show accurate
    // state.
    if (!activeWorktreeId || !worktreePath || isFolder || !isBranchVisible) {
      return
    }
    const connectionId = getConnectionId(activeWorktreeId) ?? undefined
    void fetchUpstreamStatus(
      activeWorktreeId,
      worktreePath,
      connectionId,
      activeWorktree?.pushTarget,
      { runtimeTargetSettings: activeRepoSettings }
    )
  }, [
    activeRepoSettings,
    activeWorktree?.pushTarget,
    activeWorktreeId,
    fetchUpstreamStatus,
    isBranchVisible,
    isFolder,
    worktreePath
  ])

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

  const toggleTreeDir = useCallback((key: string) => {
    setCollapsedTreeDirs((prev) => {
      const next = new Set(prev)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return next
    })
  }, [])

  const openCommittedDiff = useCallback(
    (entry: GitBranchChangeEntry, event?: SourceControlRowOpenEvent) => {
      if (
        !activeWorktreeId ||
        !worktreePath ||
        !branchSummary ||
        branchSummary.status !== 'ready'
      ) {
        return
      }
      const targetGroupId = resolveSplitTargetGroupId(event)
      openBranchDiff(
        activeWorktreeId,
        worktreePath,
        entry,
        branchSummary,
        detectLanguage(entry.path),
        { targetGroupId, preview: shouldOpenSourceControlRowAsPreview(event, targetGroupId) }
      )
    },
    [activeWorktreeId, branchSummary, openBranchDiff, resolveSplitTargetGroupId, worktreePath]
  )

  const { loadCommitFiles, openHistoryCommitDiff, openCommitFile, handleCommitAction } =
    useGitHistoryCommitActions({
      activeWorktreeId,
      worktreePath,
      activeRepoSettings,
      resolveSplitTargetGroupId
    })

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
    (comment: DiffComment) => {
      if (!activeWorktreeId || !worktreePath) {
        return
      }
      const filePath = comment.filePath
      const commentId = comment.id
      // Defensively clear any dangling prior scroll request before routing
      // this click; only the diff branches below will re-stamp it.
      cancelSourceControlEditorRevealFrames(pendingCommentEditorRevealFrameIdsRef)
      setScrollToDiffCommentId(null)
      if (getDiffCommentSource(comment) === 'markdown') {
        const absPath = joinPath(worktreePath, filePath)
        const language = detectLanguage(filePath)
        setEditorViewMode(absPath, 'edit')
        setMarkdownViewMode(absPath, 'source')
        openFile({
          filePath: absPath,
          relativePath: filePath,
          worktreeId: activeWorktreeId,
          language,
          mode: 'edit'
        })
        setPendingEditorReveal(null)
        requestSourceControlEditorRevealFrame(pendingCommentEditorRevealFrameIdsRef, () => {
          requestSourceControlEditorRevealFrame(pendingCommentEditorRevealFrameIdsRef, () => {
            setPendingEditorReveal({
              filePath: absPath,
              line: comment.lineNumber,
              column: 1,
              matchLength: 0
            })
            setScrollToDiffCommentId(commentId)
          })
        })
        return
      }
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
      setMarkdownViewMode,
      setPendingEditorReveal,
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
            // Why: route staging by the repo OWNER host, not the focused runtime.
            settings: activeRepoSettings,
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
    [activeRepoSettings, worktreePath, activeWorktreeId, refreshActiveGitStatusAfterMutation]
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
            // Why: route unstaging by the repo OWNER host, not the focused runtime.
            settings: activeRepoSettings,
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
    [activeRepoSettings, worktreePath, activeWorktreeId, refreshActiveGitStatusAfterMutation]
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
      const runtimeEnvironmentId =
        useAppStore.getState().settings?.activeRuntimeEnvironmentId?.trim() || null
      // Why: git discard replaces the working tree version of this file. Any
      // pending editor autosave must be quiesced first so it cannot recreate
      // the discarded edits after git restores the file.
      await requestEditorSaveQuiesce({
        worktreeId: activeWorktreeId,
        worktreePath,
        relativePath: filePath,
        runtimeEnvironmentId
      })
      const connectionId = getConnectionId(activeWorktreeId ?? null) ?? undefined
      await discardRuntimeGitPath(
        {
          // Why: route the discard by the repo OWNER host, not the focused runtime.
          settings: activeRepoSettings,
          worktreeId: activeWorktreeId,
          worktreePath,
          connectionId
        },
        filePath
      )
      notifyEditorExternalFileChange({
        worktreeId: activeWorktreeId,
        worktreePath,
        relativePath: filePath,
        runtimeEnvironmentId
      })
    },
    [activeRepoSettings, activeWorktreeId, worktreePath]
  )

  const discardMany = useCallback(
    async (filePaths: string[]) => {
      if (!worktreePath || !activeWorktreeId) {
        return
      }
      const runtimeEnvironmentId =
        useAppStore.getState().settings?.activeRuntimeEnvironmentId?.trim() || null
      // Why: bulk discard replaces many working-tree files at once. Quiesce
      // any matching editor autosaves before git mutates the files so a delayed
      // save cannot recreate edits after the restore.
      await Promise.all(
        filePaths.map((relativePath) =>
          requestEditorSaveQuiesce({
            worktreeId: activeWorktreeId,
            worktreePath,
            relativePath,
            runtimeEnvironmentId
          })
        )
      )
      const connectionId = getConnectionId(activeWorktreeId) ?? undefined
      await bulkDiscardRuntimeGitPaths(
        {
          // Why: route the discard by the repo OWNER host, not the focused runtime.
          settings: activeRepoSettings,
          worktreeId: activeWorktreeId,
          worktreePath,
          connectionId
        },
        filePaths
      )
      for (const relativePath of filePaths) {
        notifyEditorExternalFileChange({
          worktreeId: activeWorktreeId,
          worktreePath,
          relativePath,
          runtimeEnvironmentId
        })
      }
    },
    [activeRepoSettings, activeWorktreeId, worktreePath]
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
                // Why: route unstaging by the repo OWNER host, not the focused runtime.
                settings: activeRepoSettings,
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
          toast.error(
            translate(
              'auto.components.right.sidebar.SourceControl.a5e5a11090',
              'Discard all failed — unable to unstage files before discard'
            ),
            {
              description: errors[0] instanceof Error ? errors[0].message : undefined
            }
          )
        } else if (result.failed.length > 0) {
          // Why: only include the first error message to avoid a huge toast
          // body on bulk failures; a short sample of failed paths gives users
          // enough context to retry or investigate.
          const firstMsg = errors[0] instanceof Error ? errors[0].message : undefined
          const sample = result.failed.slice(0, 3).join(', ')
          const more = result.failed.length > 3 ? `, +${result.failed.length - 3} more` : ''
          toast.error(
            translate(
              'auto.components.right.sidebar.SourceControl.8eb3782a0c',
              'Failed to discard {{value0}} file{{value1}}',
              { value0: result.failed.length, value1: result.failed.length === 1 ? '' : 's' }
            ),
            {
              description: firstMsg
                ? translate(
                    'auto.components.right.sidebar.SourceControl.dc5a6465fc',
                    '{{value0}} (e.g. {{value1}}{{value2}})',
                    { value0: firstMsg, value1: sample, value2: more }
                  )
                : `${sample}${more}`
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
      activeRepoSettings,
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
        {translate(
          'auto.components.right.sidebar.SourceControl.c07b236287',
          'Select a workspace to view changes'
        )}
      </div>
    )
  }
  if (isFolder) {
    return (
      <div className="flex items-center justify-center h-full text-xs text-muted-foreground px-4 text-center">
        {translate(
          'auto.components.right.sidebar.SourceControl.e131cd7128',
          'Source Control is only available for Git repositories'
        )}
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

  return (
    <>
      <div ref={setSourceControlRoot} className="relative flex h-full flex-col overflow-hidden">
        <SourceControlHeaderToolbar
          filterQuery={filterQuery}
          filterExpanded={filterExpanded}
          onFilterQueryChange={setFilterQuery}
          onFilterExpandedChange={setFilterExpanded}
          visibleCreatePrHeaderAction={visibleCreatePrHeaderAction}
          hostedReview={hostedReview}
          isCreatePrIntentInFlight={isCreatePrIntentInFlight}
          isCreatingPr={isCreatingPr}
          onCreatePrHeaderClick={handleCreatePrHeaderClick}
          onOpenHostedReviewInChecks={openHostedReviewInChecks}
          sourceControlViewMode={sourceControlViewMode}
          viewModeToggleDisabled={settings === null}
          onToggleViewMode={handleToggleSourceControlViewMode}
          onChangeBaseRef={() => setBaseRefDialogOpen(true)}
          onRefreshBranchCompare={() => void refreshBranchCompare()}
          branchCompareRefreshDisabled={!branchSummary || branchSummary.status === 'loading'}
          diffCommentCount={diffCommentCount}
          onExpandNotes={() => setDiffCommentsExpanded(true)}
          branchSummary={branchSummary}
          compareBaseRef={effectiveBaseRef}
          upstreamStatus={remoteStatus}
        />

        {detachedHeadDisplay && (
          <div className="border-b border-border px-3 py-2">
            <DetachedHeadBadge display={detachedHeadDisplay} side="bottom" />
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
                title={
                  diffCommentsExpanded
                    ? translate(
                        'auto.components.right.sidebar.SourceControl.d13edef890',
                        'Collapse notes'
                      )
                    : translate(
                        'auto.components.right.sidebar.SourceControl.72f2bea3f4',
                        'Expand notes'
                      )
                }
              >
                <ChevronDown
                  className={cn(
                    'size-3 shrink-0 transition-transform',
                    !diffCommentsExpanded && '-rotate-90'
                  )}
                />
                <MessageSquare className="size-3.5 shrink-0" />
                <span>
                  {translate('auto.components.right.sidebar.SourceControl.cc474e0b8c', 'Notes')}
                </span>
                {diffCommentCount > 0 && (
                  <span className="text-[11px] leading-none text-muted-foreground tabular-nums">
                    {diffCommentCount}
                  </span>
                )}
              </button>
              <div className="ml-1 flex shrink-0 items-center gap-1.5">
                <DiffNotesSendMenu
                  worktreeId={activeWorktreeId}
                  groupId={activeGroupId ?? activeWorktreeId}
                  comments={diffCommentsForActive}
                  triggerClassName="size-6"
                />
                {diffCommentCount > 0 && (
                  <TooltipProvider delayDuration={400}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          className="inline-flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                          onClick={() => void handleCopyDiffComments()}
                          aria-label={translate(
                            'auto.components.right.sidebar.SourceControl.3baf6c77b4',
                            'Copy all notes to clipboard'
                          )}
                        >
                          {diffCommentsCopied ? (
                            <Check className="size-3.5" />
                          ) : (
                            <Copy className="size-3.5" />
                          )}
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom" sideOffset={6}>
                        {translate(
                          'auto.components.right.sidebar.SourceControl.eae2d051af',
                          'Copy all notes'
                        )}
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                )}
                <DropdownMenu>
                  <TooltipProvider delayDuration={400}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <DropdownMenuTrigger asChild>
                          <button
                            type="button"
                            className="inline-flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                            aria-label={translate(
                              'auto.components.right.sidebar.SourceControl.2fe2a67580',
                              'More note actions'
                            )}
                          >
                            <MoreHorizontal className="size-3.5" />
                          </button>
                        </DropdownMenuTrigger>
                      </TooltipTrigger>
                      <TooltipContent side="bottom" sideOffset={6}>
                        {translate(
                          'auto.components.right.sidebar.SourceControl.2fe2a67580',
                          'More note actions'
                        )}
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                  <DropdownMenuContent align="end" className="min-w-[180px]">
                    <DropdownMenuItem
                      className="text-destructive focus:text-destructive"
                      disabled={diffCommentCount === 0}
                      onSelect={() => {
                        if (!activeWorktreeId || diffCommentCount === 0) {
                          return
                        }
                        setPendingDiffCommentsClear({ kind: 'all', worktreeId: activeWorktreeId })
                      }}
                    >
                      <Trash2 className="size-3.5" />
                      {translate(
                        'auto.components.right.sidebar.SourceControl.1406954883',
                        'Clear all notes...'
                      )}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
            {diffCommentsExpanded && (
              <DiffCommentsInlineList
                comments={diffCommentsForActive}
                onDelete={(id) => void deleteDiffComment(activeWorktreeId, id)}
                onOpen={(comment) => handleOpenComment(comment)}
                onClearFile={(filePath) =>
                  setPendingDiffCommentsClear({
                    kind: 'file',
                    worktreeId: activeWorktreeId,
                    filePath
                  })
                }
              />
            )}
          </div>
        )}

        <div
          className="relative flex flex-1 flex-col overflow-auto scrollbar-sleek pt-1"
          style={{ paddingBottom: selectedKeys.size > 0 ? 50 : undefined }}
        >
          {unresolvedConflictReviewEntries.length > 0 && (
            <div className="px-3 pb-2">
              <ConflictSummaryCard
                conflictOperation={conflictOperation}
                unresolvedCount={unresolvedConflictReviewEntries.length}
                isResolvingWithAI={false}
                isAbortingOperation={isAbortingOperation}
                onAbortOperation={handleAbortOperationForConflict}
                onResolveWithAI={() => {
                  void handleResolveConflictsWithAI()
                }}
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
              <OperationBanner
                conflictOperation={conflictOperation}
                isAbortingOperation={isAbortingOperation}
                onAbortOperation={handleAbortOperationForConflict}
              />
            </div>
          )}

          {repositoryHuge && (
            <div className="px-3 pb-2">
              <TooManyChangesBanner limit={repositoryHuge.limit} />
            </div>
          )}

          {showGenericEmptyState && !normalizedFilter ? (
            <EmptyState
              heading="No changes on this branch"
              supportingText={`This workspace is clean and this branch has no changes ahead of ${branchSummary?.baseRef ?? 'base'}`}
            />
          ) : null}

          {normalizedFilter && !hasFilteredUncommittedEntries && !hasFilteredBranchEntries && (
            <EmptyState
              heading="No matching files"
              supportingText={`No changed files match "${filterQuery}"`}
            />
          )}

          {/* Why: keep CommitArea mounted across normal source-control states.
              The split-button primary rotates through Push / Pull / Sync /
              Publish on a clean tree and disables Commit with a "Nothing to
              commit" tooltip when nothing is staged — gating on
              hasUncommittedEntries (added by #1448 for the older Commit-only
              design) would unmount the whole action surface on clean
              worktrees and tear it down mid-commit when the staged list
              clears. Active merge/rebase/cherry-pick operations are the
              exception: commits would be misleading before the user continues
              or aborts the operation. */}
          {activeWorktree?.pushTarget && activeWorktree.pushTarget.remoteName !== 'origin' ? (
            <div
              className="flex items-center gap-1.5 px-1 text-[11px] text-muted-foreground"
              title={translate(
                'auto.components.right.sidebar.SourceControl.c05fe04839',
                'Pushes to the fork at {{value0}} (not origin)',
                { value0: activeWorktree.pushTarget.remoteName }
              )}
            >
              <GitFork className="size-3 shrink-0" aria-hidden="true" />
              <span className="truncate">
                {translate(
                  'auto.components.right.sidebar.SourceControl.78ce2d37ac',
                  'Pushes to fork'
                )}
                {describeForkPushTarget(activeWorktree.pushTarget)}
              </span>
            </div>
          ) : null}

          {shouldRenderCommitArea(unresolvedConflicts.length, conflictOperation) &&
            (directCreatePrAction ? (
              <CreateHostedReviewComposer
                provider={hostedReviewCreateProvider}
                branch={branchName}
                base={prBase}
                setBase={setPrBase}
                title={prTitle}
                setTitle={setPrTitle}
                body={prBody}
                setBody={setPrBody}
                draft={prDraft}
                setDraft={setPrDraft}
                baseQuery={prBaseQuery}
                setBaseQuery={setPrBaseQuery}
                baseResults={prBaseResults}
                setBaseResults={setPrBaseResults}
                baseSearchError={prBaseSearchError}
                aiGenerationEnabled={prAiGenerationEnabled}
                generating={prGenerating}
                generateDisabled={prGenerateDisabled}
                generateDisabledReason={prGenerateDisabledReason}
                generateError={prGenerateError}
                createError={
                  createPrIntentNotice?.tone === 'destructive' ? createPrIntentNotice.message : null
                }
                isCreating={isCreatingPr}
                primaryAction={directCreatePrAction}
                dropdownItems={dropdownItems}
                onGenerate={handleGeneratePullRequestFieldsClick}
                onCancelGenerate={handleCancelGeneratePullRequestFields}
                onPrimaryAction={() => {
                  void handleCreatePullRequest()
                }}
                onDropdownAction={handleActionInvoke}
              />
            ) : (
              <CommitArea
                worktreeId={activeWorktreeId}
                connectionId={activeConnectionId}
                repoId={activeRepo?.id ?? null}
                launchPlatform={activeSourceControlLaunchPlatform}
                commitMessage={commitMessage}
                commitError={commitError}
                commitFailureRecoveryPrompt={commitFailureRecoveryPrompt}
                remoteActionError={remoteActionError?.message ?? null}
                createPrIntentNotice={createPrIntentNotice}
                isCommitting={isCommitting}
                isFixingCommitFailureWithAI={isLaunchingCommitFailureAgent}
                isCreatingPr={isCreatingPr || isCreatePrIntentInFlight}
                isCreatePrIntentInFlight={isCreatePrIntentInFlight}
                groupId={activeGroupId ?? activeWorktreeId}
                showComposer={!showGenericEmptyState}
                aiEnabled={resolvedCommitMessageAi?.ok === true}
                aiAgentConfigured={resolvedCommitMessageAi?.ok === true}
                isGenerating={isGenerating}
                generateError={generateError}
                stagedCount={grouped.staged.length}
                hasPartiallyStagedChanges={hasPartiallyStagedChanges}
                hasUnresolvedConflicts={unresolvedConflicts.length > 0}
                isRemoteOperationActive={isRemoteOperationActive || isAbortingOperation}
                inFlightRemoteOpKind={inFlightRemoteOpKind}
                primaryAction={primaryAction}
                dropdownItems={dropdownItems}
                fixCommitFailureRecipe={getLaunchActionRecipe('fixCommitFailure')}
                onCommitMessageChange={(value) => {
                  if (!activeWorktreeId) {
                    return
                  }
                  updateCommitDrafts((prev) =>
                    writeCommitDraftForWorktree(prev, activeWorktreeId, value)
                  )
                }}
                onGenerate={handleGenerateCommitMessageClick}
                onCancelGenerate={handleCancelGenerate}
                onSaveLaunchActionDefault={saveLaunchActionDefault}
                onOpenSourceControlAiSettings={openSourceControlAiSettings}
                onFixCommitFailureWithAI={handleFixCommitFailureWithAI}
                onPrimaryAction={handlePrimaryClick}
                onDropdownAction={handleActionInvoke}
              />
            ))}

          {hasFilteredUncommittedEntries && (
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
                const sectionLabel = SECTION_LABELS[area]
                return (
                  <div key={area}>
                    <SectionHeader
                      label={translate(sectionLabel.key, sectionLabel.fallback)}
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
                          <div className="flex items-center can-hover:opacity-0 transition-opacity group-hover/section:opacity-100 focus-within:opacity-100">
                            {canRevertAll && (
                              <ActionButton
                                icon={area === 'untracked' ? Trash : Undo2}
                                // Why: for untracked files, discard deletes the file
                                // outright (rm -rf via git.discard's untracked branch).
                                // A generic "Discard all" label hides that severity —
                                // label explicitly for the destructive variant.
                                title={
                                  area === 'untracked'
                                    ? translate(
                                        'auto.components.right.sidebar.SourceControl.2f609a2e7c',
                                        'Delete all untracked'
                                      )
                                    : translate(
                                        'auto.components.right.sidebar.SourceControl.ce41708855',
                                        'Discard all'
                                      )
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
                                title={translate(
                                  'auto.components.right.sidebar.SourceControl.24d2598eff',
                                  'Stage all'
                                )}
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
                                title={translate(
                                  'auto.components.right.sidebar.SourceControl.9339382454',
                                  'Unstage all'
                                )}
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
                              {translate(
                                'auto.components.right.sidebar.SourceControl.48db37cca9',
                                'View all'
                              )}
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
                              {translate(
                                'auto.components.right.sidebar.SourceControl.48db37cca9',
                                'View all'
                              )}
                            </Button>
                          )}
                        </>
                      }
                    />
                    {!isCollapsed &&
                      (sourceControlViewMode === 'tree'
                        ? visibleTreeRowsByArea[area].map((node) => {
                            if (node.type === 'directory') {
                              return (
                                <SourceControlTreeDirectoryRow
                                  key={node.key}
                                  node={node}
                                  actionPaths={getSourceControlDirectoryActionPaths(node)}
                                  hideBulkActions={Boolean(normalizedFilter)}
                                  isExecutingBulk={isExecutingBulk}
                                  isCollapsed={collapsedTreeDirs.has(node.key)}
                                  onToggle={() => toggleTreeDir(node.key)}
                                  onRequestDiscardPaths={(discardArea, paths) =>
                                    setPendingDiscard({
                                      kind: 'area',
                                      area: discardArea,
                                      paths
                                    })
                                  }
                                  onStagePaths={handleStageAllPaths}
                                  onUnstagePaths={handleUnstagePaths}
                                />
                              )
                            }
                            return (
                              <UncommittedEntryRow
                                key={node.key}
                                entryKey={node.key}
                                entry={node.entry}
                                currentWorktreeId={currentWorktreeId}
                                worktreePath={worktreePath}
                                depth={node.depth}
                                selected={selectedKeySet.has(node.key)}
                                isOpenFile={activeOpenRowKeys.has(node.key)}
                                onSelect={handleSelect}
                                onContextMenu={handleContextMenu}
                                onRevealInExplorer={revealInExplorer}
                                onOpen={handleOpenDiff}
                                onStage={handleStage}
                                onUnstage={handleUnstage}
                                onDiscard={requestDiscardEntry}
                                commentCount={diffCommentCountByPath.get(node.entry.path) ?? 0}
                                showPathHint={false}
                              />
                            )
                          })
                        : items.map((entry) => {
                            const key = `${entry.area}::${entry.path}`
                            return (
                              <UncommittedEntryRow
                                key={key}
                                entryKey={key}
                                entry={entry}
                                currentWorktreeId={currentWorktreeId}
                                worktreePath={worktreePath}
                                selected={selectedKeySet.has(key)}
                                isOpenFile={activeOpenRowKeys.has(key)}
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
                          }))}
                  </div>
                )
              })}
            </>
          )}

          {shouldShowSourceControlCompareUnavailableCard(
            branchSummary,
            hasUncommittedEntries,
            branchEntries.length > 0,
            Boolean(normalizedFilter)
          ) && branchSummary ? (
            <CompareUnavailable
              summary={branchSummary}
              onChangeBaseRef={() => setBaseRefDialogOpen(true)}
              onRetry={() => void refreshBranchCompare()}
            />
          ) : null}

          {branchSummary?.status === 'ready' && hasFilteredBranchEntries && (
            <div>
              <SectionHeader
                label={translate(
                  'auto.components.right.sidebar.SourceControl.d7ae61269b',
                  'Committed on Branch'
                )}
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
                    {translate(
                      'auto.components.right.sidebar.SourceControl.48db37cca9',
                      'View all'
                    )}
                  </Button>
                }
              />
              {!collapsedSections.has('branch') &&
                (sourceControlViewMode === 'tree'
                  ? visibleBranchTreeRows.map((node) => {
                      if (node.type === 'directory') {
                        return (
                          <SourceControlBranchTreeDirectoryRow
                            key={node.key}
                            node={node}
                            isCollapsed={collapsedTreeDirs.has(node.key)}
                            onToggle={() => toggleTreeDir(node.key)}
                          />
                        )
                      }
                      return (
                        <BranchEntryRow
                          key={node.key}
                          entry={node.entry}
                          currentWorktreeId={currentWorktreeId}
                          worktreePath={worktreePath}
                          depth={node.depth}
                          onRevealInExplorer={revealInExplorer}
                          onOpen={(event) => openCommittedDiff(node.entry, event)}
                          commentCount={diffCommentCountByPath.get(node.entry.path) ?? 0}
                          showPathHint={false}
                        />
                      )
                    })
                  : filteredBranchEntries.map((entry) => (
                      <BranchEntryRow
                        key={`branch:${entry.path}`}
                        entry={entry}
                        currentWorktreeId={currentWorktreeId}
                        worktreePath={worktreePath}
                        onRevealInExplorer={revealInExplorer}
                        onOpen={(event) => openCommittedDiff(entry, event)}
                        commentCount={diffCommentCountByPath.get(entry.path) ?? 0}
                      />
                    )))}
            </div>
          )}

          {isGitHistoryVisible && (
            // Why: the graph is reference context for the whole panel, so when
            // file sections are short it should occupy the bottom, and when the
            // pane scrolls it should remain docked as branch context.
            <div className="sticky bottom-0 z-10 mt-auto shrink-0 border-t border-border bg-sidebar/95 backdrop-blur-sm">
              <GitHistoryPanel
                state={gitHistoryState}
                collapsed={collapsedSections.has('history')}
                onToggle={() => toggleSection('history')}
                onRefresh={() => void refreshGitHistory()}
                onOpenCommit={(item) => void openHistoryCommitDiff(item)}
                onLoadCommitFiles={loadCommitFiles}
                onOpenCommitFile={openCommitFile}
                onCommitAction={handleCommitAction}
              />
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
        open={resolvedPendingDiffCommentsClear !== null}
        onOpenChange={(open) => {
          if (!open && !isClearingDiffComments) {
            setPendingDiffCommentsClear(null)
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-sm">
              {translate('auto.components.right.sidebar.SourceControl.574d2f4413', 'Clear Notes')}
            </DialogTitle>
            <DialogDescription className="text-xs">
              {pendingDiffCommentsClearDescription}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setPendingDiffCommentsClear(null)}
              disabled={isClearingDiffComments}
            >
              {translate('auto.components.right.sidebar.SourceControl.05bb8f4a48', 'Cancel')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => void handleConfirmDiffCommentsClear()}
              disabled={isClearingDiffComments || pendingDiffCommentsClearCount === 0}
            >
              <Trash2 className="size-4" />
              {translate('auto.components.right.sidebar.SourceControl.574d2f4413', 'Clear Notes')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <SourceControlDiscardDialog
        pendingDiscard={pendingDiscard}
        onCancel={() => setPendingDiscard(null)}
        onConfirm={confirmPendingDiscard}
      />

      <Dialog open={baseRefDialogOpen} onOpenChange={setBaseRefDialogOpen}>
        <DialogContent className="flex max-h-[min(85vh,36rem)] max-w-xl flex-col overflow-hidden">
          <DialogHeader className="shrink-0">
            <DialogTitle className="text-sm">
              {translate(
                'auto.components.right.sidebar.SourceControl.476b77745b',
                'Change Base Ref'
              )}
            </DialogTitle>
            <DialogDescription className="text-xs">
              {translate(
                'auto.components.right.sidebar.SourceControl.c9ad22888e',
                'Pick the branch compare target for this repository.'
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 overflow-y-auto scrollbar-sleek">
            <BaseRefPicker
              repoId={activeRepo.id}
              currentBaseRef={pickerBaseRef}
              onSelect={(ref) => {
                if (baseRefOwnedByWorktree && activeWorktreeId) {
                  void updateWorktreeMeta(activeWorktreeId, { baseRef: ref })
                } else {
                  void updateRepo(activeRepo.id, { worktreeBaseRef: ref })
                }
                setBaseRefDialogOpen(false)
                window.setTimeout(() => void refreshBranchCompare(), 0)
              }}
              onUsePrimary={() => {
                if (baseRefOwnedByWorktree && activeWorktreeId) {
                  void updateWorktreeMeta(activeWorktreeId, { baseRef: undefined })
                } else {
                  void updateRepo(activeRepo.id, { worktreeBaseRef: undefined })
                }
                setBaseRefDialogOpen(false)
                window.setTimeout(() => void refreshBranchCompare(), 0)
              }}
            />
          </div>
        </DialogContent>
      </Dialog>
      <SourceControlAgentActionDialog
        open={resolveConflictsComposerOpen}
        onOpenChange={setResolveConflictsComposerOpen}
        actionId="resolveConflicts"
        title={translate(
          'auto.components.right.sidebar.SourceControl.19652ddd76',
          'Resolve Conflicts With AI'
        )}
        description={translate(
          'auto.components.right.sidebar.SourceControl.901140f47d',
          'Review and edit the full command input before starting an agent.'
        )}
        baseCommandInput={resolveConflictsPrompt}
        worktreeId={activeWorktreeId}
        groupId={activeGroupId ?? activeWorktreeId}
        connectionId={activeConnectionId}
        repoId={activeRepo?.id ?? null}
        promptDelivery="submit-after-ready"
        launchPlatform={activeSourceControlLaunchPlatform}
        launchSource="conflict_resolution"
        savedAgentId={readSourceControlLaunchRecipeAgentId(
          getLaunchActionRecipe('resolveConflicts')
        )}
        savedCommandInputTemplate={
          getLaunchActionRecipe('resolveConflicts').commandInputTemplate ?? null
        }
        savedAgentArgs={getLaunchActionRecipe('resolveConflicts').agentArgs ?? null}
        onSaveAgentDefault={saveLaunchActionDefault}
        onOpenSettings={openSourceControlAiSettings}
        onLaunched={() =>
          toast.success(
            translate(
              'auto.components.right.sidebar.SourceControl.e48caaf0dd',
              'Started an AI agent for the conflicts.'
            )
          )
        }
      />
      <SourceControlTextGenerationDialog
        open={commitGenerationDialogOpen}
        onOpenChange={setCommitGenerationDialogOpen}
        actionId="commitMessage"
        title={translate(
          'auto.components.right.sidebar.SourceControl.6b122529d4',
          'Generate Commit Message'
        )}
        description={translate(
          'auto.components.right.sidebar.SourceControl.f4c766f1ca',
          'Choose the agent and command template for this run.'
        )}
        generateLabel="Generate"
        settings={settings}
        repo={activeRepo ?? null}
        discoveryHostKey={sourceControlAiDiscoveryHostKey}
        onGenerate={(params) => {
          void handleGenerate({ sourceControlAiResolvedParams: params })
        }}
        onSaveDefaults={handleSaveCommitMessageGenerationDefaults}
      />
      <SourceControlTextGenerationDialog
        open={pullRequestGenerationDialogOpen}
        onOpenChange={setPullRequestGenerationDialogOpen}
        actionId="pullRequest"
        title={translate(
          'auto.components.right.sidebar.SourceControl.1a6a6e0bc5',
          'Generate Hosted Review Details'
        )}
        description={translate(
          'auto.components.right.sidebar.SourceControl.f4c766f1ca',
          'Choose the agent and command template for this run.'
        )}
        generateLabel="Generate"
        settings={settings}
        repo={activeRepo ?? null}
        discoveryHostKey={sourceControlAiDiscoveryHostKey}
        onGenerate={(params) => {
          void handleGeneratePullRequestFields({ sourceControlAiResolvedParams: params })
        }}
        onSaveDefaults={handleSavePullRequestGenerationDefaults}
      />
    </>
  )
}

const SourceControl = React.memo(SourceControlInner)
export default SourceControl

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
