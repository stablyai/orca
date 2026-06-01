/* eslint-disable max-lines */
import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type {
  DetectedWorktreeListResult,
  TerminalLayoutSnapshot,
  TerminalPaneLayoutNode,
  LocalBaseRefRefreshResult,
  ForceDeleteWorktreeBranchResult,
  GitHubPrStartPoint,
  Worktree,
  WorkspaceVisibleTabType,
  GitPushTarget,
  RemoveWorktreeResult,
  WorktreeLineage,
  WorktreeMeta
} from '../../../../shared/types'
import type { RuntimeWorktreeListResult } from '../../../../shared/runtime-types'
import {
  findWorktreeById,
  applyWorktreeUpdates,
  getRepoIdFromWorktreeId,
  type WorktreeSlice
} from './worktree-helpers'
import { ensureHooksConfirmed } from '@/lib/ensure-hooks-confirmed'
import { tabHasLivePty } from '@/lib/tab-has-live-pty'
import {
  callRuntimeRpc,
  getActiveRuntimeTarget,
  RuntimeRpcCallError
} from '../../runtime/runtime-rpc-client'
import { getHostedReviewCacheKey, refreshHostedReviewCard } from './hosted-review'
import { getGitHubPRCacheKey, getLegacyGitHubPRCacheKey } from './github-cache-key'
import { moveFocusToRendererBeforeFocusedWebviewHidden } from './browser-webview-cleanup'
import { toast } from 'sonner'
import { requestVirtualizedScrollAnchorRecord } from '@/hooks/requestVirtualizedScrollAnchorRecord'
import { branchName } from '@/lib/git-utils'
import { markInputQuietSchedulerInput, scheduleAfterInputQuiet } from '@/lib/input-quiet-scheduler'
export type { WorktreeSlice, WorktreeDeleteState } from './worktree-helpers'

// Why: old runtime servers only have `worktree.list`; preserve the large-list
// UI hydration parity this slice used before `worktree.detectedList` existed.
const REMOTE_WORKTREE_LIST_PARITY_LIMIT = 10_000
const ACTIVE_WORKTREE_TERMINAL_PREP_DELAY_MS = 300
const ACTIVE_WORKTREE_TERMINAL_PREP_INPUT_QUIET_MS = 450
const ACTIVE_WORKTREE_TERMINAL_PREP_IDLE_TIMEOUT_MS = 180
const pendingActivationTerminalPrepCancels = new Map<string, () => void>()

function countTerminalLayoutLeaves(node: TerminalPaneLayoutNode | null | undefined): number {
  if (!node) {
    return 0
  }
  if (node.type === 'leaf') {
    return 1
  }
  return countTerminalLayoutLeaves(node.first) + countTerminalLayoutLeaves(node.second)
}

function getActivationSpawnSuppression(layout: TerminalLayoutSnapshot | undefined): true | number {
  const paneCount = Math.max(
    1,
    countTerminalLayoutLeaves(layout?.root),
    Object.keys(layout?.ptyIdsByLeafId ?? {}).length
  )
  return paneCount === 1 ? true : paneCount
}

function shouldDeferActivationTerminalPrep(): boolean {
  return typeof window !== 'undefined' && import.meta.env.MODE !== 'test'
}

function showLocalBaseRefRefreshToast(result: LocalBaseRefRefreshResult | undefined): void {
  if (!result || result.status === 'updated') {
    return
  }

  let reason: string
  switch (result.status) {
    case 'skipped_dirty_worktree':
      reason =
        'the worktree where it is checked out has uncommitted changes. Commit, stash, or discard those changes, then try again.'
      break
    case 'skipped_not_fast_forward':
      reason =
        'the local branch does not exist or cannot be fast-forwarded cleanly from the remote base. Check for local-only commits before updating it manually.'
      break
    case 'skipped_error':
      reason =
        'Git returned an error while updating the local ref. Check the repo for locked refs or unusual worktree state, then try again.'
      break
  }

  toast.warning(`Local ${result.localBranch} was not refreshed`, {
    description: `Workspace created from ${result.baseRef}, but Orca could not fast-forward local ${result.localBranch} because ${reason}`
  })
}

function showPreservedBranchToast(
  result: RemoveWorktreeResult | undefined,
  worktree: Pick<Worktree, 'displayName' | 'isMainWorktree'> | undefined,
  onForceDelete: (branchName: string, expectedHead: string) => void
): void {
  const preservedBranch = result?.preservedBranch
  const branch = preservedBranch?.branchName
  if (!branch) {
    return
  }
  const targetTitle = worktree?.isMainWorktree ? 'Workspace' : 'Worktree'
  const targetLabel = targetTitle.toLowerCase()
  const targetName = worktree?.displayName?.trim()
  const deletedTarget = targetName ? ` after deleting ${targetLabel} "${targetName}"` : ''
  const expectedHead = preservedBranch.head
  const action = expectedHead
    ? {
        label: 'Force Delete Branch',
        onClick: () => onForceDelete(branch, expectedHead)
      }
    : undefined
  toast.warning(`${targetTitle} deleted, branch kept`, {
    description: `Git could not safely delete branch "${branch}"${deletedTarget}, so Orca kept it to avoid losing local commits.`,
    ...(action ? { action } : {})
  })
}

function arraysShallowEqual(a: string[] | undefined, b: string[] | undefined): boolean {
  if (a === b) {
    return true
  }
  if (!a || !b || a.length !== b.length) {
    return !a?.length && !b?.length
  }
  return a.every((v, i) => v === b[i])
}

function areLineageRecordsEqual(
  a: WorktreeLineage | null | undefined,
  b: WorktreeLineage | null | undefined
): boolean {
  if (!a || !b) {
    return !a && !b
  }
  return (
    a.worktreeId === b.worktreeId &&
    a.worktreeInstanceId === b.worktreeInstanceId &&
    a.parentWorktreeId === b.parentWorktreeId &&
    a.parentWorktreeInstanceId === b.parentWorktreeInstanceId &&
    a.origin === b.origin &&
    a.capture.source === b.capture.source &&
    a.capture.confidence === b.capture.confidence &&
    a.orchestrationRunId === b.orchestrationRunId &&
    a.taskId === b.taskId &&
    a.coordinatorHandle === b.coordinatorHandle &&
    a.createdByTerminalHandle === b.createdByTerminalHandle &&
    a.createdAt === b.createdAt
  )
}

function areWorktreesEqual(current: Worktree[] | undefined, next: Worktree[]): boolean {
  if (!current || current.length !== next.length) {
    return false
  }

  return current.every((worktree, index) => {
    const candidate = next[index]
    return (
      worktree.id === candidate.id &&
      worktree.instanceId === candidate.instanceId &&
      worktree.repoId === candidate.repoId &&
      worktree.path === candidate.path &&
      worktree.head === candidate.head &&
      worktree.branch === candidate.branch &&
      worktree.isBare === candidate.isBare &&
      worktree.isMainWorktree === candidate.isMainWorktree &&
      worktree.isSparse === candidate.isSparse &&
      worktree.displayName === candidate.displayName &&
      worktree.comment === candidate.comment &&
      worktree.linkedIssue === candidate.linkedIssue &&
      worktree.linkedPR === candidate.linkedPR &&
      worktree.linkedGitLabMR === candidate.linkedGitLabMR &&
      worktree.linkedGitLabIssue === candidate.linkedGitLabIssue &&
      worktree.isArchived === candidate.isArchived &&
      worktree.isUnread === candidate.isUnread &&
      worktree.isPinned === candidate.isPinned &&
      worktree.sortOrder === candidate.sortOrder &&
      worktree.manualOrder === candidate.manualOrder &&
      worktree.lastActivityAt === candidate.lastActivityAt &&
      worktree.workspaceStatus === candidate.workspaceStatus &&
      worktree.createdWithAgent === candidate.createdWithAgent &&
      worktree.baseRef === candidate.baseRef &&
      worktree.pushTarget?.remoteName === candidate.pushTarget?.remoteName &&
      worktree.pushTarget?.branchName === candidate.pushTarget?.branchName &&
      worktree.pushTarget?.remoteUrl === candidate.pushTarget?.remoteUrl &&
      worktree.sparseBaseRef === candidate.sparseBaseRef &&
      arraysShallowEqual(worktree.sparseDirectories, candidate.sparseDirectories) &&
      (worktree as WorktreeWithLineage).parentWorktreeId ===
        (candidate as WorktreeWithLineage).parentWorktreeId &&
      arraysShallowEqual(
        (worktree as WorktreeWithLineage).childWorktreeIds,
        (candidate as WorktreeWithLineage).childWorktreeIds
      ) &&
      areLineageRecordsEqual(
        (worktree as WorktreeWithLineage).lineage,
        (candidate as WorktreeWithLineage).lineage
      )
    )
  })
}

function areDetectedWorktreeResultsEqual(
  current: DetectedWorktreeListResult | undefined,
  next: DetectedWorktreeListResult
): boolean {
  return Boolean(
    current &&
    current.repoId === next.repoId &&
    current.authoritative === next.authoritative &&
    current.source === next.source &&
    areWorktreesEqual(current.worktrees, next.worktrees) &&
    current.worktrees.every((worktree, index) => {
      const candidate = next.worktrees[index]
      return (
        worktree.ownership === candidate.ownership &&
        worktree.selectedCheckout === candidate.selectedCheckout &&
        worktree.visible === candidate.visible
      )
    })
  )
}

function toVisibleTabType(contentType: string): WorkspaceVisibleTabType {
  return contentType === 'browser' ? 'browser' : contentType === 'terminal' ? 'terminal' : 'editor'
}

function toRuntimeWorktreeIdSelector(worktreeId: string): string {
  return `id:${worktreeId}`
}

const FORCE_RETRYABLE_WORKTREE_REMOVAL_MESSAGES = [
  'Worktree has uncommitted or untracked changes',
  'contains modified or untracked files',
  'Worktree is no longer registered with Git but its directory remains'
] as const

// Why: local preflight formatting can surface raw git porcelain instead of the
// friendly dirty-worktree message; only those status prefixes are forceable.
const FORMATTED_DIRTY_WORKTREE_REMOVAL_PATTERN =
  /Failed to delete worktree at [^\n]*\.\s*(?:(?:[MADRCUT][ MADRCUT]| [MADRCUT]|\?\?)\s+\S)/

function canRetryWorktreeRemovalWithForce(error: string, force: boolean | undefined): boolean {
  if (force) {
    return false
  }
  // Why: force only helps backend safety refusals that are explicitly safe to
  // retry with user confirmation; transport/provider errors need recovery first.
  return (
    FORCE_RETRYABLE_WORKTREE_REMOVAL_MESSAGES.some((message) => error.includes(message)) ||
    FORMATTED_DIRTY_WORKTREE_REMOVAL_PATTERN.test(error)
  )
}

type WorktreeWithLineage = Worktree & {
  parentWorktreeId?: string | null
  childWorktreeIds?: string[]
  lineage?: WorktreeLineage | null
}

function toVisibleWorktree(worktree: DetectedWorktreeListResult['worktrees'][number]): Worktree {
  const {
    ownership: _ownership,
    selectedCheckout: _selectedCheckout,
    visible: _visible,
    ...base
  } = worktree
  return base
}

function toVisibleWorktrees(result: DetectedWorktreeListResult): Worktree[] {
  return result.worktrees.filter((worktree) => worktree.visible).map(toVisibleWorktree)
}

function getHydratedSessionWorktreeIdsForRepo(state: AppState, repoId: string): string[] {
  return Object.keys(state.tabsByWorktree).filter((id) => getRepoIdFromWorktreeId(id) === repoId)
}

function getKnownWorktreeIdsForPurge(state: AppState, repoId: string): string[] {
  const detected = state.detectedWorktreesByRepo[repoId]
  const knownIds = new Set<string>()
  if (detected?.authoritative === true) {
    for (const worktree of detected.worktrees) {
      knownIds.add(worktree.id)
    }
  } else {
    for (const worktree of state.worktreesByRepo[repoId] ?? []) {
      knownIds.add(worktree.id)
    }
  }
  if (!state.hasHydratedWorktreePurge) {
    // Why (#1158): hydration can preserve tab keys before worktree metadata exists;
    // the first authoritative scan still needs to reap deleted session-only keys.
    for (const id of getHydratedSessionWorktreeIdsForRepo(state, repoId)) {
      knownIds.add(id)
    }
  }
  return [...knownIds]
}

function getRemovedWorktreeIdsAfterAuthoritativeScan(
  state: AppState,
  repoId: string,
  detected: DetectedWorktreeListResult
): string[] {
  if (!detected.authoritative) {
    return []
  }
  const detectedIds = new Set(detected.worktrees.map((worktree) => worktree.id))
  return getKnownWorktreeIdsForPurge(state, repoId).filter((id) => !detectedIds.has(id))
}

function toLegacyDetectedWorktreeResult(
  repoId: string,
  result: { worktrees: Worktree[] }
): DetectedWorktreeListResult {
  return {
    repoId,
    authoritative: true,
    source: 'session-fallback',
    worktrees: result.worktrees.map((worktree) => ({
      ...worktree,
      ownership: 'orca-managed',
      selectedCheckout: false,
      visible: true
    }))
  }
}

function isRuntimeMethodNotFoundError(error: unknown): boolean {
  return error instanceof RuntimeRpcCallError && error.code === 'method_not_found'
}

function applyDetectedWorktreeUpdates(
  detectedWorktreesByRepo: AppState['detectedWorktreesByRepo'],
  worktreeId: string,
  updates: Partial<WorktreeMeta>
): AppState['detectedWorktreesByRepo'] {
  let changed = false
  const nextByRepo: AppState['detectedWorktreesByRepo'] = {}

  for (const [repoId, result] of Object.entries(detectedWorktreesByRepo)) {
    let repoChanged = false
    const nextWorktrees = result.worktrees.map((worktree) => {
      if (worktree.id !== worktreeId) {
        return worktree
      }
      repoChanged = true
      changed = true
      return { ...worktree, ...updates }
    })
    nextByRepo[repoId] = repoChanged ? { ...result, worktrees: nextWorktrees } : result
  }

  return changed ? nextByRepo : detectedWorktreesByRepo
}

function findKnownWorktreeById(
  state: Pick<AppState, 'worktreesByRepo' | 'detectedWorktreesByRepo'>,
  worktreeId: string
): Worktree | DetectedWorktreeListResult['worktrees'][number] | undefined {
  const visible = findWorktreeById(state.worktreesByRepo, worktreeId)
  if (visible) {
    return visible
  }
  for (const result of Object.values(state.detectedWorktreesByRepo)) {
    const detected = result.worktrees.find((worktree) => worktree.id === worktreeId)
    if (detected) {
      return detected
    }
  }
  return undefined
}

function isRuntimeSelectorNotFoundError(error: unknown): boolean {
  if (
    error &&
    typeof error === 'object' &&
    'cause' in error &&
    isRuntimeSelectorNotFoundError((error as { cause?: unknown }).cause)
  ) {
    return true
  }
  const code =
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof (error as { code: unknown }).code === 'string'
      ? (error as { code: string }).code
      : null
  const responseCode =
    error &&
    typeof error === 'object' &&
    'response' in error &&
    typeof (error as { response?: { error?: { code?: unknown } } }).response?.error?.code ===
      'string'
      ? (error as { response: { error: { code: string } } }).response.error.code
      : null
  const responseMessage =
    error &&
    typeof error === 'object' &&
    'response' in error &&
    typeof (error as { response?: { error?: { message?: unknown } } }).response?.error?.message ===
      'string'
      ? (error as { response: { error: { message: string } } }).response.error.message
      : null
  const message = error instanceof Error ? error.message : String(error)
  return (
    message === 'selector_not_found' ||
    message.includes('selector_not_found') ||
    code === 'selector_not_found' ||
    responseCode === 'selector_not_found' ||
    responseMessage === 'selector_not_found' ||
    String(error).includes('selector_not_found')
  )
}

function replaceWorktreeInRepoLists(
  worktreesByRepo: Record<string, Worktree[]>,
  updatedWorktree: Worktree
): Record<string, Worktree[]> {
  const repoId = getRepoIdFromWorktreeId(updatedWorktree.id)
  const current = worktreesByRepo[repoId]
  if (!current) {
    return worktreesByRepo
  }
  return {
    ...worktreesByRepo,
    [repoId]: current.map((worktree) =>
      worktree.id === updatedWorktree.id ? updatedWorktree : worktree
    )
  }
}

async function listDetectedWorktreesForRepo(
  settings: AppState['settings'],
  repoId: string
): Promise<DetectedWorktreeListResult> {
  const target = getActiveRuntimeTarget(settings)
  if (target.kind === 'local') {
    const worktreesApi = window.api.worktrees as typeof window.api.worktrees & {
      listDetected?: typeof window.api.worktrees.listDetected
    }
    if (typeof worktreesApi.listDetected === 'function') {
      return worktreesApi.listDetected({ repoId })
    }
    const legacyWorktrees = await worktreesApi.list({ repoId })
    return toLegacyDetectedWorktreeResult(repoId, { worktrees: legacyWorktrees })
  }
  try {
    return await callRuntimeRpc<DetectedWorktreeListResult>(
      target,
      'worktree.detectedList',
      { repo: repoId },
      { timeoutMs: 15_000 }
    )
  } catch (error) {
    if (!isRuntimeMethodNotFoundError(error)) {
      throw error
    }
    const legacy = await callRuntimeRpc<RuntimeWorktreeListResult>(
      target,
      'worktree.list',
      { repo: repoId, limit: REMOTE_WORKTREE_LIST_PARITY_LIMIT },
      { timeoutMs: 15_000 }
    )
    return toLegacyDetectedWorktreeResult(repoId, legacy)
  }
}

async function listWorktreeLineageForRuntime(
  settings: AppState['settings']
): Promise<Record<string, WorktreeLineage>> {
  const target = getActiveRuntimeTarget(settings)
  if (target.kind === 'local') {
    return window.api.worktrees.listLineage()
  }
  return (
    await callRuntimeRpc<{ lineage: Record<string, WorktreeLineage> }>(
      target,
      'worktree.lineageList',
      undefined,
      { timeoutMs: 15_000 }
    )
  ).lineage
}

async function refreshRemoteWorktreeLineageBestEffort(
  settings: AppState['settings'],
  set: (partial: Partial<AppState>) => void
): Promise<void> {
  if (getActiveRuntimeTarget(settings).kind === 'local') {
    return
  }
  try {
    set({ worktreeLineageById: await listWorktreeLineageForRuntime(settings) })
  } catch (err) {
    // Why: lineage is supplemental to the worktree list. A remote timeout here
    // must not discard a successful worktree refresh.
    console.error('Failed to fetch worktree lineage:', err)
  }
}

async function persistWorktreeMeta(
  settings: AppState['settings'],
  worktreeId: string,
  updates: Partial<WorktreeMeta>
): Promise<void> {
  const target = getActiveRuntimeTarget(settings)
  if (target.kind === 'local') {
    await window.api.worktrees.updateMeta({ worktreeId, updates })
    return
  }
  await callRuntimeRpc(
    target,
    'worktree.set',
    { worktree: toRuntimeWorktreeIdSelector(worktreeId), ...updates },
    { timeoutMs: 15_000 }
  )
}

async function resolveLinkedPrPushTarget(
  settings: AppState['settings'],
  repoId: string,
  prNumber: number
): Promise<GitPushTarget | undefined> {
  try {
    const target = getActiveRuntimeTarget(settings)
    const result =
      target.kind === 'local'
        ? await window.api.worktrees.resolvePrBase({ repoId, prNumber })
        : await callRuntimeRpc<GitHubPrStartPoint | { error: string }>(
            target,
            'worktree.resolvePrBase',
            { repo: repoId, prNumber },
            { timeoutMs: 30_000 }
          )
    if ('error' in result) {
      console.warn(`Failed to resolve push target for PR #${prNumber}: ${result.error}`)
      return undefined
    }
    return result.pushTarget
  } catch (error) {
    console.warn(
      `Failed to resolve push target for PR #${prNumber}:`,
      error instanceof Error ? error.message : error
    )
    return undefined
  }
}

function buildWorktreePurgeState(s: AppState, worktreeIds: string[]): Partial<AppState> {
  const worktreeIdSet = new Set(worktreeIds)

  // Collect every tab id (and removed file id) we are about to orphan.
  const doomedTabIds = new Set<string>()
  const removedFileIds = new Set<string>()
  for (const id of worktreeIdSet) {
    for (const tab of s.tabsByWorktree[id] ?? []) {
      doomedTabIds.add(tab.id)
    }
  }
  for (const file of s.openFiles) {
    if (worktreeIdSet.has(file.worktreeId)) {
      removedFileIds.add(file.id)
    }
  }

  const omitByWorktree = <T>(obj: Record<string, T>): Record<string, T> => {
    let changed = false
    const out = { ...obj }
    for (const id of worktreeIdSet) {
      if (id in out) {
        delete out[id]
        changed = true
      }
    }
    return changed ? out : obj
  }
  const omitByTabId = <T>(obj: Record<string, T>): Record<string, T> => {
    let changed = false
    const out = { ...obj }
    for (const tabId of doomedTabIds) {
      if (tabId in out) {
        delete out[tabId]
        changed = true
      }
    }
    return changed ? out : obj
  }
  const omitByFileId = <T>(obj: Record<string, T>): Record<string, T> => {
    let changed = false
    const out = { ...obj }
    for (const fileId of removedFileIds) {
      if (fileId in out) {
        delete out[fileId]
        changed = true
      }
    }
    return changed ? out : obj
  }

  const nextOpenFiles = s.openFiles.some((f) => worktreeIdSet.has(f.worktreeId))
    ? s.openFiles.filter((f) => !worktreeIdSet.has(f.worktreeId))
    : s.openFiles

  const removedActive = s.activeWorktreeId != null && worktreeIdSet.has(s.activeWorktreeId)
  const activeFileCleared = s.activeFileId != null && removedFileIds.has(s.activeFileId)
  const activeTabCleared = s.activeTabId != null && doomedTabIds.has(s.activeTabId)

  const nextEverActivatedWorktreeIds = (() => {
    let hit = false
    for (const id of worktreeIdSet) {
      if (s.everActivatedWorktreeIds.has(id)) {
        hit = true
        break
      }
    }
    if (!hit) {
      return s.everActivatedWorktreeIds
    }
    const next = new Set(s.everActivatedWorktreeIds)
    for (const id of worktreeIdSet) {
      next.delete(id)
    }
    return next
  })()

  return {
    // Worktree-scoped terminal/tab state
    worktreeLineageById: omitByWorktree(s.worktreeLineageById),
    tabsByWorktree: omitByWorktree(s.tabsByWorktree),
    terminalLayoutsByTabId: omitByTabId(s.terminalLayoutsByTabId),
    ptyIdsByTabId: omitByTabId(s.ptyIdsByTabId),
    runtimePaneTitlesByTabId: omitByTabId(s.runtimePaneTitlesByTabId),
    // Delete state
    deleteStateByWorktreeId: omitByWorktree(s.deleteStateByWorktreeId),
    baseStatusByWorktreeId: omitByWorktree(s.baseStatusByWorktreeId),
    remoteBranchConflictByWorktreeId: omitByWorktree(s.remoteBranchConflictByWorktreeId),
    // File search
    fileSearchStateByWorktree: omitByWorktree(s.fileSearchStateByWorktree),
    // Browser state
    browserTabsByWorktree: omitByWorktree(s.browserTabsByWorktree),
    recentlyClosedBrowserTabsByWorktree: omitByWorktree(s.recentlyClosedBrowserTabsByWorktree),
    activeBrowserTabIdByWorktree: omitByWorktree(s.activeBrowserTabIdByWorktree),
    // Editor state
    activeFileIdByWorktree: omitByWorktree(s.activeFileIdByWorktree),
    activeTabTypeByWorktree: omitByWorktree(s.activeTabTypeByWorktree),
    activeTabIdByWorktree: omitByWorktree(s.activeTabIdByWorktree),
    tabBarOrderByWorktree: omitByWorktree(s.tabBarOrderByWorktree),
    pendingReconnectTabByWorktree: omitByWorktree(s.pendingReconnectTabByWorktree),
    rightSidebarTabByWorktree: omitByWorktree(s.rightSidebarTabByWorktree),
    // Split-tab / unified tab state
    unifiedTabsByWorktree: omitByWorktree(s.unifiedTabsByWorktree),
    groupsByWorktree: omitByWorktree(s.groupsByWorktree),
    layoutByWorktree: omitByWorktree(s.layoutByWorktree),
    activeGroupIdByWorktree: omitByWorktree(s.activeGroupIdByWorktree),
    // Git status caches
    gitStatusByWorktree: omitByWorktree(s.gitStatusByWorktree),
    gitIgnoredPathsByWorktree: omitByWorktree(s.gitIgnoredPathsByWorktree),
    gitConflictOperationByWorktree: omitByWorktree(s.gitConflictOperationByWorktree),
    trackedConflictPathsByWorktree: omitByWorktree(s.trackedConflictPathsByWorktree),
    gitBranchChangesByWorktree: omitByWorktree(s.gitBranchChangesByWorktree),
    gitBranchCompareSummaryByWorktree: omitByWorktree(s.gitBranchCompareSummaryByWorktree),
    gitBranchCompareRequestKeyByWorktree: omitByWorktree(s.gitBranchCompareRequestKeyByWorktree),
    showDotfilesByWorktree: omitByWorktree(s.showDotfilesByWorktree),
    expandedDirs: omitByWorktree(s.expandedDirs),
    // Per-file editor state for removed files
    editorDrafts: omitByFileId(s.editorDrafts),
    markdownViewMode: omitByFileId(s.markdownViewMode),
    // Top-level actives
    openFiles: nextOpenFiles,
    everActivatedWorktreeIds: nextEverActivatedWorktreeIds,
    lastVisitedAtByWorktreeId: omitByWorktree(s.lastVisitedAtByWorktreeId),
    activeWorktreeId: removedActive ? null : s.activeWorktreeId,
    activeFileId: activeFileCleared ? null : s.activeFileId,
    activeBrowserTabId: removedActive ? null : s.activeBrowserTabId,
    activeTabId: activeTabCleared ? null : s.activeTabId,
    activeTabType: removedActive || activeFileCleared ? 'terminal' : s.activeTabType
  }
}

export const createWorktreeSlice: StateCreator<AppState, [], [], WorktreeSlice> = (set, get) => ({
  worktreesByRepo: {},
  detectedWorktreesByRepo: {},
  worktreeLineageById: {},
  activeWorktreeId: null,
  deleteStateByWorktreeId: {},
  baseStatusByWorktreeId: {},
  remoteBranchConflictByWorktreeId: {},
  sortEpoch: 0,
  everActivatedWorktreeIds: new Set<string>(),
  lastVisitedAtByWorktreeId: {},
  hasHydratedWorktreePurge: false,

  fetchDetectedWorktrees: async (repoId) => {
    try {
      const result = await listDetectedWorktreesForRepo(get().settings, repoId)
      set((s) =>
        areDetectedWorktreeResultsEqual(s.detectedWorktreesByRepo[repoId], result)
          ? s
          : { detectedWorktreesByRepo: { ...s.detectedWorktreesByRepo, [repoId]: result } }
      )
      return result
    } catch (err) {
      console.error(`Failed to fetch detected worktrees for repo ${repoId}:`, err)
      return null
    }
  },

  fetchWorktrees: async (repoId, options) => {
    try {
      const settings = get().settings
      const detected = await listDetectedWorktreesForRepo(settings, repoId)
      if (options?.requireAuthoritative && !detected.authoritative) {
        return false
      }
      const worktrees = toVisibleWorktrees(detected)
      const current = get().worktreesByRepo[repoId]
      if (areWorktreesEqual(current, worktrees)) {
        set((s) => {
          const removedIds = getRemovedWorktreeIdsAfterAuthoritativeScan(s, repoId, detected)
          if (
            areDetectedWorktreeResultsEqual(s.detectedWorktreesByRepo[repoId], detected) &&
            removedIds.length === 0
          ) {
            return s
          }
          return {
            detectedWorktreesByRepo: { ...s.detectedWorktreesByRepo, [repoId]: detected },
            ...(removedIds.length > 0 ? buildWorktreePurgeState(s, removedIds) : {})
          }
        })
        await refreshRemoteWorktreeLineageBestEffort(settings, set)
        return detected.authoritative
      }

      // Why: `git worktree list` can fail transiently (e.g. concurrent git
      // operations holding a lock, disk I/O hiccup). The backend catches these
      // errors and returns []. Replacing a known-good worktree list with []
      // causes tabsByWorktree entries to become orphaned — the agent activity
      // badge then shows raw worktree IDs instead of display names, and click-
      // to-navigate silently fails because findWorktreeById returns undefined.
      // Keep the stale-but-correct data until the next successful refresh.
      if (!detected.authoritative && worktrees.length === 0 && current && current.length > 0) {
        set((s) => ({
          detectedWorktreesByRepo: { ...s.detectedWorktreesByRepo, [repoId]: detected }
        }))
        return false
      }

      set((s) => {
        // Why: hidden worktrees are not in worktreesByRepo. Purge decisions
        // must diff against the previous authoritative detected list so hiding
        // does not delete state, and deleting a hidden worktree still does.
        const removedIds = getRemovedWorktreeIdsAfterAuthoritativeScan(s, repoId, detected)

        return {
          // Why: active worktrees can change branches entirely from a terminal.
          // We refresh that live git identity into renderer state, but only bump
          // sortEpoch when git actually reports a different worktree payload.
          worktreesByRepo: { ...s.worktreesByRepo, [repoId]: worktrees },
          detectedWorktreesByRepo: { ...s.detectedWorktreesByRepo, [repoId]: detected },
          sortEpoch: s.sortEpoch + 1,
          ...(removedIds.length > 0 ? buildWorktreePurgeState(s, removedIds) : {})
        }
      })
      await refreshRemoteWorktreeLineageBestEffort(settings, set)
      return detected.authoritative
    } catch (err) {
      console.error(`Failed to fetch worktrees for repo ${repoId}:`, err)
      return false
    }
  },

  fetchAllWorktrees: async () => {
    const { repos } = get()

    // Why: once the one-shot hydration-time purge has fired, subsequent
    // calls just need to refresh each repo's cached list. No need to
    // double-probe the IPC for the per-repo success signal.
    if (get().hasHydratedWorktreePurge) {
      await Promise.all(repos.map((r) => get().fetchWorktrees(r.id)))
      return
    }

    // Why: users upgrading from a pre-fix build may have persisted
    // tabsByWorktree entries for worktrees that were deleted in the previous
    // session. Without the hydration-time purge below those entries would
    // keep zombie PTYs misclassified as "bound" in SessionsStatusSegment
    // (design §2c), which means the user would still need a second restart
    // post-upgrade to reclaim memory.
    //
    // Safety gate: fetchWorktrees swallows IPC errors and short-circuits on
    // empty-replace when cached data exists. Neither signal bubbles up to the
    // caller, so we probe the IPC directly to get the per-repo success signal,
    // then apply that same payload to state instead of listing each repo again.
    const results = await Promise.all(
      repos.map(async (r) => {
        try {
          const detected = await listDetectedWorktreesForRepo(get().settings, r.id)
          const list = toVisibleWorktrees(detected)
          const current = get().worktreesByRepo[r.id]
          if (
            !areWorktreesEqual(current, list) &&
            !(list.length === 0 && current && current.length > 0 && !detected.authoritative)
          ) {
            set((s) => ({
              worktreesByRepo: { ...s.worktreesByRepo, [r.id]: list },
              detectedWorktreesByRepo: { ...s.detectedWorktreesByRepo, [r.id]: detected },
              sortEpoch: s.sortEpoch + 1
            }))
          } else {
            set((s) => ({
              detectedWorktreesByRepo: { ...s.detectedWorktreesByRepo, [r.id]: detected }
            }))
          }
          return { repoId: r.id, ok: detected.authoritative, detected }
        } catch (err) {
          console.error(`Failed to fetch worktrees for repo ${r.id}:`, err)
          return { repoId: r.id, ok: false as const }
        }
      })
    )

    const hasAnyDetectedWorktree = results.some(
      (result) => 'detected' in result && result.ok && result.detected.worktrees.length > 0
    )
    const allSucceeded = results.length > 0 && results.every((r) => r.ok) && hasAnyDetectedWorktree
    if (!allSucceeded) {
      // Defer; try again on the next fetchAllWorktrees call.
      return
    }
    const validIds = new Set<string>()
    for (const result of Object.values(get().detectedWorktreesByRepo)) {
      if (!result.authoritative) {
        continue
      }
      for (const w of result.worktrees) {
        validIds.add(w.id)
      }
    }
    const stale = Object.keys(get().tabsByWorktree).filter((id) => !validIds.has(id))
    if (stale.length > 0) {
      console.warn(
        `[worktree-purge] hydration-time purge removing stale state for ${stale.length} worktree(s):`,
        stale
      )
      get().purgeWorktreeTerminalState(stale)
    }
    set({ hasHydratedWorktreePurge: true })
  },

  fetchWorktreeLineage: async () => {
    try {
      set({ worktreeLineageById: await listWorktreeLineageForRuntime(get().settings) })
    } catch (err) {
      console.error('Failed to fetch worktree lineage:', err)
    }
  },

  updateWorktreeLineage: async (worktreeId, args) => {
    try {
      const target = getActiveRuntimeTarget(get().settings)
      let updatedRemoteWorktree: WorktreeWithLineage | undefined
      const lineage =
        target.kind === 'local'
          ? await window.api.worktrees.updateLineage({ worktreeId, ...args })
          : await callRuntimeRpc<{ worktree: WorktreeWithLineage }>(
              target,
              'worktree.set',
              {
                worktree: toRuntimeWorktreeIdSelector(worktreeId),
                ...(args.parentWorktreeId ? { parentWorktree: `id:${args.parentWorktreeId}` } : {}),
                ...(args.noParent === true ? { noParent: true } : {})
              },
              { timeoutMs: 15_000 }
            ).then((result) => {
              updatedRemoteWorktree = result.worktree
              return result.worktree.lineage ?? null
            })
      set((s) => {
        const next = { ...s.worktreeLineageById }
        if (lineage) {
          next[worktreeId] = lineage
        } else {
          delete next[worktreeId]
        }
        return {
          worktreeLineageById: next,
          worktreesByRepo:
            target.kind === 'local' || !updatedRemoteWorktree
              ? s.worktreesByRepo
              : replaceWorktreeInRepoLists(s.worktreesByRepo, updatedRemoteWorktree),
          sortEpoch: s.sortEpoch + 1
        }
      })
    } catch (err) {
      console.error('Failed to update worktree lineage:', err)
      await get().fetchWorktreeLineage()
    }
  },

  updateWorktreeGitIdentity: (worktreeId, identity) => {
    set((s) => {
      const repoId = getRepoIdFromWorktreeId(worktreeId)
      const current = s.worktreesByRepo[repoId]
      if (!current) {
        return {}
      }

      let changed = false
      const next = current.map((worktree) => {
        if (worktree.id !== worktreeId) {
          return worktree
        }
        const nextHead = identity.head ?? worktree.head
        const nextBranch = identity.branch ?? worktree.branch
        if (nextHead === worktree.head && nextBranch === worktree.branch) {
          return worktree
        }
        changed = true
        // Why: terminal branch switches only patch branch/head here; auto-derived
        // titles need the same branch derivation that full worktree listing uses.
        const wasAutoDerived = worktree.displayName === branchName(worktree.branch)
        const nextDisplayName = wasAutoDerived ? branchName(nextBranch) : worktree.displayName
        return { ...worktree, head: nextHead, branch: nextBranch, displayName: nextDisplayName }
      })

      if (!changed) {
        return {}
      }

      return {
        worktreesByRepo: { ...s.worktreesByRepo, [repoId]: next },
        sortEpoch: s.sortEpoch + 1
      }
    })
  },

  updateWorktreeBaseStatus: (event) => {
    set((s) => ({
      baseStatusByWorktreeId: {
        ...s.baseStatusByWorktreeId,
        [event.worktreeId]: event
      }
    }))
  },

  updateWorktreeRemoteBranchConflict: (event) => {
    set((s) => ({
      remoteBranchConflictByWorktreeId: {
        ...s.remoteBranchConflictByWorktreeId,
        [event.worktreeId]: event
      }
    }))
  },

  prefetchWorktreeCreateBase: async (repoId, baseBranch) => {
    try {
      const target = getActiveRuntimeTarget(get().settings)
      if (target.kind === 'local') {
        await window.api.worktrees.prefetchCreateBase({
          repoId,
          ...(baseBranch ? { baseBranch } : {})
        })
        return
      }
      await callRuntimeRpc(
        target,
        'worktree.prefetchCreateBase',
        { repo: repoId, ...(baseBranch ? { baseBranch } : {}) },
        { timeoutMs: 30_000 }
      )
    } catch {
      // Why: prefetch is only a latency hedge. The create path awaits the same
      // backend refresh and owns user-visible error reporting.
    }
  },

  createWorktree: async (
    repoId,
    name,
    baseBranch,
    setupDecision = 'inherit',
    sparseCheckout,
    telemetrySource,
    displayName,
    linkedIssue,
    linkedPR,
    pushTarget,
    createdWithAgent,
    linkedLinearIssue,
    branchNameOverride,
    workspaceStatus,
    linkedGitLabMR,
    linkedGitLabIssue,
    startup
  ) => {
    const retryableConflictPatterns = [
      /already exists locally/i,
      /already exists on a remote/i,
      /^Branch ".+" already exists\./i,
      /already has pr #\d+/i
    ]
    const nextCandidateName = (current: string, attempt: number): string =>
      attempt === 0 ? current : `${current}-${attempt + 1}`
    const isBranchNameOverrideConflict = (error: Error): boolean =>
      Boolean(
        branchNameOverride &&
        (/^Branch ".+" already exists\./i.test(error.message) ||
          /already exists locally/i.test(error.message) ||
          /already exists on a remote/i.test(error.message) ||
          /already has pr #\d+/i.test(error.message))
      )

    try {
      for (let attempt = 0; attempt < 25; attempt += 1) {
        const candidateName = nextCandidateName(name, attempt)
        try {
          // Why: Manual sort is user-authored order. Stamp new workspaces
          // deliberately at the top instead of relying on sortOrder fallback.
          const manualOrder = get().sortBy === 'manual' ? Date.now() : undefined
          const createArgs = {
            repoId,
            name: candidateName,
            baseBranch,
            ...(branchNameOverride ? { branchNameOverride } : {}),
            setupDecision,
            sparseCheckout,
            ...(displayName ? { displayName } : {}),
            ...(telemetrySource ? { telemetrySource } : {}),
            ...(linkedIssue !== undefined ? { linkedIssue } : {}),
            ...(linkedPR !== undefined ? { linkedPR } : {}),
            ...(pushTarget ? { pushTarget } : {}),
            ...(createdWithAgent ? { createdWithAgent } : {}),
            ...(linkedLinearIssue !== undefined ? { linkedLinearIssue } : {}),
            ...(manualOrder !== undefined ? { manualOrder } : {}),
            ...(workspaceStatus !== undefined ? { workspaceStatus } : {}),
            ...(linkedGitLabMR !== undefined ? { linkedGitLabMR } : {}),
            ...(linkedGitLabIssue !== undefined ? { linkedGitLabIssue } : {})
          }
          const target = getActiveRuntimeTarget(get().settings)
          const result =
            target.kind === 'local'
              ? await window.api.worktrees.create(createArgs)
              : await callRuntimeRpc<Awaited<ReturnType<typeof window.api.worktrees.create>>>(
                  target,
                  'worktree.create',
                  {
                    repo: repoId,
                    name: candidateName,
                    baseBranch,
                    ...(branchNameOverride ? { branchNameOverride } : {}),
                    setupDecision,
                    sparseCheckout,
                    ...(displayName ? { displayName } : {}),
                    ...(telemetrySource ? { telemetrySource } : {}),
                    ...(linkedIssue !== undefined ? { linkedIssue } : {}),
                    ...(linkedPR !== undefined ? { linkedPR } : {}),
                    ...(pushTarget ? { pushTarget } : {}),
                    ...(createdWithAgent ? { createdWithAgent } : {}),
                    ...(linkedLinearIssue !== undefined ? { linkedLinearIssue } : {}),
                    ...(manualOrder !== undefined ? { manualOrder } : {}),
                    ...(workspaceStatus !== undefined ? { workspaceStatus } : {}),
                    ...(linkedGitLabMR !== undefined ? { linkedGitLabMR } : {}),
                    ...(linkedGitLabIssue !== undefined ? { linkedGitLabIssue } : {}),
                    ...(startup
                      ? {
                          startupCommand: startup.command,
                          ...(startup.env ? { startupEnv: startup.env } : {}),
                          activate: true
                        }
                      : {})
                  },
                  { timeoutMs: 10 * 60_000 }
                )
          // Why: a file watcher (worktrees.onChanged) can fire between the
          // backend creating the worktree and this callback running, causing
          // fetchWorktrees to add the worktree first. Appending unconditionally
          // then produces a duplicate entry in worktreesByRepo, which gives
          // React duplicate keys and can corrupt terminal DOM containers.
          set((s) => {
            const current = s.worktreesByRepo[repoId] ?? []
            const alreadyPresent = current.some((w) => w.id === result.worktree.id)
            return {
              worktreesByRepo: {
                ...s.worktreesByRepo,
                [repoId]: alreadyPresent ? current : [...current, result.worktree]
              },
              ...(result.initialBaseStatus
                ? {
                    baseStatusByWorktreeId: {
                      ...s.baseStatusByWorktreeId,
                      [result.worktree.id]:
                        s.baseStatusByWorktreeId[result.worktree.id] ?? result.initialBaseStatus
                    }
                  }
                : {}),
              sortEpoch: s.sortEpoch + 1
            }
          })
          showLocalBaseRefRefreshToast(result.localBaseRefRefresh)
          return result
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          const shouldRetry = retryableConflictPatterns.some((pattern) => pattern.test(message))
          if (error instanceof Error && isBranchNameOverrideConflict(error)) {
            throw error
          }
          if (!shouldRetry || attempt === 24) {
            throw error
          }
        }
      }

      throw new Error('Failed to create worktree after retrying branch conflicts.')
    } catch (err) {
      console.error('Failed to create worktree:', err)
      throw err
    }
  },

  removeWorktree: async (worktreeId, force) => {
    set((s) => ({
      deleteStateByWorktreeId: {
        ...s.deleteStateByWorktreeId,
        [worktreeId]: {
          isDeleting: true,
          error: null,
          canForceDelete: false
        }
      }
    }))

    try {
      const repoIdForTrust = getRepoIdFromWorktreeId(worktreeId)
      const trustDecision = await ensureHooksConfirmed(get(), repoIdForTrust, 'archive')
      const skipArchive = trustDecision === 'skip'

      const worktreeBeforeRemoval = get()
        .allWorktrees()
        .find((entry) => entry.id === worktreeId)
      const target = getActiveRuntimeTarget(get().settings)
      const removalResult = await (target.kind === 'local'
        ? window.api.worktrees.remove({ worktreeId, force, skipArchive })
        : callRuntimeRpc<RemoveWorktreeResult>(
            target,
            'worktree.rm',
            { worktree: worktreeId, force, runHooks: !skipArchive },
            { timeoutMs: 60_000 }
          ))

      const worktreeDisplayName = worktreeBeforeRemoval?.displayName?.trim()
      if (worktreeDisplayName) {
        try {
          await window.api.automations?.snapshotWorkspaceName?.({
            workspaceId: worktreeId,
            displayName: worktreeDisplayName
          })
        } catch (error) {
          // Why: preserving automation history labels is best-effort; a stale
          // preload/test harness must not block worktree removal cleanup.
          console.warn('Failed to snapshot automation workspace name:', error)
        }
      }

      // Why: backend delete paths now preflight and kill PTYs only after the
      // worktree is cleanly removable. Renderer state follows the successful
      // backend result so blocked dirty deletes keep their terminals intact.
      //
      // Why browsers first: `shutdownWorktreeTerminals` used to own the
      // `browserTabsByWorktree[worktreeId]` delete as a side effect, which would
      // race `shutdownWorktreeBrowsers`' read of the same map. After the §1.3
      // split, terminals no longer touches browser state, but we still call
      // browsers first so destroyPersistentWebview sees the workspaces in place
      // and the Chromium guests are unregistered before any other teardown work
      // can intercept them.
      await get().shutdownWorktreeBrowsers(worktreeId)
      await get().shutdownWorktreeTerminals(worktreeId)
      const tabs = get().tabsByWorktree[worktreeId] ?? []
      const tabIds = new Set(tabs.map((t) => t.id))

      // Why: deletion is async (backend + terminal/browser teardown awaited
      // above), so snapshot the sidebar's current top-row anchor in the same
      // tick we remove the row. Recording at click time goes stale across the
      // await, and this covers every delete entry point (modal, card, SSH,
      // batch) rather than only the context menu.
      requestVirtualizedScrollAnchorRecord('[data-worktree-sidebar]')

      set((s) => {
        const next = { ...s.worktreesByRepo }
        for (const repoId of Object.keys(next)) {
          next[repoId] = next[repoId].filter((w) => w.id !== worktreeId)
        }
        const nextTabs = { ...s.tabsByWorktree }
        delete nextTabs[worktreeId]
        const nextLayouts = { ...s.terminalLayoutsByTabId }
        const nextPtyIdsByTabId = { ...s.ptyIdsByTabId }
        const nextRuntimePaneTitlesByTabId = { ...s.runtimePaneTitlesByTabId }
        for (const tabId of tabIds) {
          delete nextLayouts[tabId]
          delete nextPtyIdsByTabId[tabId]
          delete nextRuntimePaneTitlesByTabId[tabId]
        }
        const nextDeleteState = { ...s.deleteStateByWorktreeId }
        delete nextDeleteState[worktreeId]
        const nextLineage = { ...s.worktreeLineageById }
        delete nextLineage[worktreeId]
        // Clean up editor files belonging to this worktree
        const newOpenFiles = s.openFiles.filter((f) => f.worktreeId !== worktreeId)
        const nextBrowserTabsByWorktree = { ...s.browserTabsByWorktree }
        delete nextBrowserTabsByWorktree[worktreeId]
        const nextActiveFileIdByWorktree = { ...s.activeFileIdByWorktree }
        delete nextActiveFileIdByWorktree[worktreeId]
        const nextActiveBrowserTabIdByWorktree = { ...s.activeBrowserTabIdByWorktree }
        delete nextActiveBrowserTabIdByWorktree[worktreeId]
        // Why: closeBrowserTab — which shutdownWorktreeBrowsers delegates to —
        // pushes a snapshot into recentlyClosedBrowserTabsByWorktree for the
        // Cmd+Shift+T undo path. That is correct for UI close, but wrong when
        // the owning worktree itself is being deleted: the snapshots reference
        // workspaces and pages that can never be restored. Purge the worktree
        // key symmetrically with browserTabsByWorktree. Per-workspace page
        // snapshots are already cleared upstream by closeBrowserTab.
        const nextRecentlyClosedBrowserTabsByWorktree = {
          ...s.recentlyClosedBrowserTabsByWorktree
        }
        delete nextRecentlyClosedBrowserTabsByWorktree[worktreeId]
        const nextActiveTabTypeByWorktree = { ...s.activeTabTypeByWorktree }
        delete nextActiveTabTypeByWorktree[worktreeId]
        const nextActiveTabIdByWorktree = { ...s.activeTabIdByWorktree }
        delete nextActiveTabIdByWorktree[worktreeId]
        const nextTabBarOrderByWorktree = { ...s.tabBarOrderByWorktree }
        // Why: the mixed terminal/editor/browser tab strip persists visual order
        // per worktree. If a deleted worktree keeps its entry, stale tab IDs stay
        // retained indefinitely even though reconcileTabOrder filters them later.
        delete nextTabBarOrderByWorktree[worktreeId]
        const nextPendingReconnectTabByWorktree = { ...s.pendingReconnectTabByWorktree }
        delete nextPendingReconnectTabByWorktree[worktreeId]
        // Why: split-tab layout/group state is owned by the worktree. Leaving it
        // behind retains full tab chrome for terminals/editors/browser tabs that
        // no longer exist and makes a deleted worktree look restorable in session
        // state even though its backing entities were already removed.
        const nextUnifiedTabsByWorktree = { ...s.unifiedTabsByWorktree }
        delete nextUnifiedTabsByWorktree[worktreeId]
        const nextGroupsByWorktree = { ...s.groupsByWorktree }
        delete nextGroupsByWorktree[worktreeId]
        const nextLayoutByWorktree = { ...s.layoutByWorktree }
        delete nextLayoutByWorktree[worktreeId]
        const nextActiveGroupIdByWorktree = { ...s.activeGroupIdByWorktree }
        delete nextActiveGroupIdByWorktree[worktreeId]
        // Why: git status / compare caches are keyed by worktree and stop being
        // refreshed once the worktree is deleted. Remove them here so deleted
        // worktrees cannot retain stale conflict badges, branch diffs, or compare
        // request keys indefinitely in a long-lived renderer session.
        const nextGitStatusByWorktree = { ...s.gitStatusByWorktree }
        delete nextGitStatusByWorktree[worktreeId]
        const nextGitIgnoredPathsByWorktree = { ...s.gitIgnoredPathsByWorktree }
        delete nextGitIgnoredPathsByWorktree[worktreeId]
        const nextGitConflictOperationByWorktree = { ...s.gitConflictOperationByWorktree }
        delete nextGitConflictOperationByWorktree[worktreeId]
        const nextTrackedConflictPathsByWorktree = { ...s.trackedConflictPathsByWorktree }
        delete nextTrackedConflictPathsByWorktree[worktreeId]
        const nextGitBranchChangesByWorktree = { ...s.gitBranchChangesByWorktree }
        delete nextGitBranchChangesByWorktree[worktreeId]
        const nextGitBranchCompareSummaryByWorktree = { ...s.gitBranchCompareSummaryByWorktree }
        delete nextGitBranchCompareSummaryByWorktree[worktreeId]
        const nextGitBranchCompareRequestKeyByWorktree = {
          ...s.gitBranchCompareRequestKeyByWorktree
        }
        delete nextGitBranchCompareRequestKeyByWorktree[worktreeId]
        // Why: clean up per-file editor state for files belonging to the removed
        // worktree so stale drafts and view modes never accumulate in memory.
        const removedFileIds = new Set(
          s.openFiles.filter((f) => f.worktreeId === worktreeId).map((f) => f.id)
        )
        const nextEditorDrafts = removedFileIds.size > 0 ? { ...s.editorDrafts } : s.editorDrafts
        const nextMarkdownViewMode =
          removedFileIds.size > 0 ? { ...s.markdownViewMode } : s.markdownViewMode
        const nextEditorViewMode =
          removedFileIds.size > 0 ? { ...s.editorViewMode } : s.editorViewMode
        if (removedFileIds.size > 0) {
          for (const fileId of removedFileIds) {
            delete nextEditorDrafts[fileId]
            delete nextMarkdownViewMode[fileId]
            delete nextEditorViewMode[fileId]
          }
        }
        const nextExpandedDirs = { ...s.expandedDirs }
        delete nextExpandedDirs[worktreeId]
        const nextShowDotfilesByWorktree = { ...s.showDotfilesByWorktree }
        delete nextShowDotfilesByWorktree[worktreeId]
        // If the active file belonged to the removed worktree, clear it
        const activeFileCleared = s.activeFileId
          ? s.openFiles.some((f) => f.id === s.activeFileId && f.worktreeId === worktreeId)
          : false
        const removedActiveWorktree = s.activeWorktreeId === worktreeId
        const nextEverActivatedWorktreeIds = s.everActivatedWorktreeIds.has(worktreeId)
          ? new Set([...s.everActivatedWorktreeIds].filter((id) => id !== worktreeId))
          : s.everActivatedWorktreeIds
        const nextLastVisitedAtByWorktreeId =
          worktreeId in s.lastVisitedAtByWorktreeId
            ? (() => {
                const next = { ...s.lastVisitedAtByWorktreeId }
                delete next[worktreeId]
                return next
              })()
            : s.lastVisitedAtByWorktreeId
        return {
          worktreesByRepo: next,
          worktreeLineageById: nextLineage,
          tabsByWorktree: nextTabs,
          ptyIdsByTabId: nextPtyIdsByTabId,
          runtimePaneTitlesByTabId: nextRuntimePaneTitlesByTabId,
          terminalLayoutsByTabId: nextLayouts,
          deleteStateByWorktreeId: nextDeleteState,
          baseStatusByWorktreeId: (() => {
            const nextStatus = { ...s.baseStatusByWorktreeId }
            delete nextStatus[worktreeId]
            return nextStatus
          })(),
          remoteBranchConflictByWorktreeId: (() => {
            const nextConflict = { ...s.remoteBranchConflictByWorktreeId }
            delete nextConflict[worktreeId]
            return nextConflict
          })(),
          fileSearchStateByWorktree: (() => {
            const nextSearch = { ...s.fileSearchStateByWorktree }
            // Why: file search UI state is worktree-scoped. Removing the worktree
            // must also remove its cached query/results so another worktree never
            // inherits stale matches from a path that no longer exists.
            delete nextSearch[worktreeId]
            return nextSearch
          })(),
          activeWorktreeId: removedActiveWorktree ? null : s.activeWorktreeId,
          activeTabId: s.activeTabId && tabIds.has(s.activeTabId) ? null : s.activeTabId,
          openFiles: newOpenFiles,
          browserTabsByWorktree: nextBrowserTabsByWorktree,
          recentlyClosedBrowserTabsByWorktree: nextRecentlyClosedBrowserTabsByWorktree,
          activeFileIdByWorktree: nextActiveFileIdByWorktree,
          activeBrowserTabIdByWorktree: nextActiveBrowserTabIdByWorktree,
          activeTabTypeByWorktree: nextActiveTabTypeByWorktree,
          activeTabIdByWorktree: nextActiveTabIdByWorktree,
          tabBarOrderByWorktree: nextTabBarOrderByWorktree,
          pendingReconnectTabByWorktree: nextPendingReconnectTabByWorktree,
          unifiedTabsByWorktree: nextUnifiedTabsByWorktree,
          groupsByWorktree: nextGroupsByWorktree,
          layoutByWorktree: nextLayoutByWorktree,
          activeGroupIdByWorktree: nextActiveGroupIdByWorktree,
          editorDrafts: nextEditorDrafts,
          markdownViewMode: nextMarkdownViewMode,
          editorViewMode: nextEditorViewMode,
          showDotfilesByWorktree: nextShowDotfilesByWorktree,
          expandedDirs: nextExpandedDirs,
          gitStatusByWorktree: nextGitStatusByWorktree,
          gitIgnoredPathsByWorktree: nextGitIgnoredPathsByWorktree,
          gitConflictOperationByWorktree: nextGitConflictOperationByWorktree,
          trackedConflictPathsByWorktree: nextTrackedConflictPathsByWorktree,
          gitBranchChangesByWorktree: nextGitBranchChangesByWorktree,
          gitBranchCompareSummaryByWorktree: nextGitBranchCompareSummaryByWorktree,
          gitBranchCompareRequestKeyByWorktree: nextGitBranchCompareRequestKeyByWorktree,
          activeFileId: activeFileCleared ? null : s.activeFileId,
          activeBrowserTabId: removedActiveWorktree ? null : s.activeBrowserTabId,
          activeTabType: removedActiveWorktree || activeFileCleared ? 'terminal' : s.activeTabType,
          everActivatedWorktreeIds: nextEverActivatedWorktreeIds,
          lastVisitedAtByWorktreeId: nextLastVisitedAtByWorktreeId,
          sortEpoch: s.sortEpoch + 1
        }
      })
      get().removeWorkspaceSpaceWorktrees?.([worktreeId])
      const preservedBranch = removalResult?.preservedBranch
      if (preservedBranch) {
        showPreservedBranchToast(removalResult, worktreeBeforeRemoval, (branch, expectedHead) => {
          void get().forceDeletePreservedBranch(worktreeId, branch, expectedHead)
        })
      }
      return preservedBranch ? { ok: true as const, preservedBranch } : { ok: true as const }
    } catch (err) {
      // Why: git refusing a non-force delete for dirty/untracked files is a
      // handled user decision point surfaced by the delete toast, not an app error.
      console.warn('Failed to remove worktree:', err)
      const error = err instanceof Error ? err.message : String(err)
      set((s) => ({
        deleteStateByWorktreeId: {
          ...s.deleteStateByWorktreeId,
          [worktreeId]: {
            isDeleting: false,
            error,
            canForceDelete: canRetryWorktreeRemovalWithForce(error, force)
          }
        }
      }))
      return { ok: false as const, error }
    }
  },

  markWorktreesDeleting: (worktreeIds) => {
    if (worktreeIds.length === 0) {
      return
    }
    set((s) => {
      const nextDeleteState = { ...s.deleteStateByWorktreeId }
      let changed = false
      for (const worktreeId of new Set(worktreeIds)) {
        const current = nextDeleteState[worktreeId]
        if (current?.isDeleting && current.error === null && !current.canForceDelete) {
          continue
        }
        nextDeleteState[worktreeId] = {
          isDeleting: true,
          error: null,
          canForceDelete: false
        }
        changed = true
      }
      return changed ? { deleteStateByWorktreeId: nextDeleteState } : {}
    })
  },

  forceDeletePreservedBranch: async (worktreeId, branchName, expectedHead) => {
    try {
      const target = getActiveRuntimeTarget(get().settings)
      const result = await (target.kind === 'local'
        ? window.api.worktrees.forceDeletePreservedBranch({
            worktreeId,
            branchName,
            expectedHead
          })
        : callRuntimeRpc<ForceDeleteWorktreeBranchResult>(
            target,
            'worktree.forceDeleteBranch',
            { worktree: worktreeId, branchName, expectedHead },
            { timeoutMs: 15_000 }
          ))
      toast.success('Local branch deleted', {
        description: `Deleted "${branchName}".`
      })
      return { ok: true as const, ...result }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      toast.error('Failed to delete branch', {
        description: error
      })
      return { ok: false as const, error }
    }
  },

  clearWorktreeDeleteState: (worktreeId) => {
    set((s) => {
      if (!s.deleteStateByWorktreeId[worktreeId]) {
        return {}
      }
      const next = { ...s.deleteStateByWorktreeId }
      delete next[worktreeId]
      return { deleteStateByWorktreeId: next }
    })
  },

  updateWorktreeMeta: async (worktreeId, updates, options) => {
    const shouldApplyUpdate = options?.shouldApply
    const existingWorktree = get().getKnownWorktreeById(worktreeId)
    if (shouldApplyUpdate && !shouldApplyUpdate(existingWorktree)) {
      return
    }
    // Why: manual PR linking only supplies the PR number. Resolve the PR head
    // branch here so Push targets the review branch, but don't repeat that
    // network lookup for no-op linkedPR metadata saves.
    const linkedPrForPushTarget =
      typeof updates.linkedPR === 'number' && Number.isFinite(updates.linkedPR)
        ? updates.linkedPR
        : null
    const resolvedPushTarget =
      linkedPrForPushTarget !== null &&
      updates.pushTarget === undefined &&
      existingWorktree &&
      existingWorktree.linkedPR !== linkedPrForPushTarget &&
      !existingWorktree.pushTarget
        ? await resolveLinkedPrPushTarget(
            get().settings,
            existingWorktree.repoId,
            linkedPrForPushTarget
          )
        : undefined
    const worktreeForUpdate = get().getKnownWorktreeById(worktreeId)
    if (shouldApplyUpdate && !shouldApplyUpdate(worktreeForUpdate)) {
      return
    }
    const shouldRefreshHostedReview =
      updates.linkedPR === null && worktreeForUpdate?.linkedPR !== null
    const reviewRepo = shouldRefreshHostedReview
      ? get().repos.find((repo) => repo.id === worktreeForUpdate?.repoId)
      : undefined
    const reviewBranch = worktreeForUpdate?.branch.replace(/^refs\/heads\//, '')

    // Why: editing a comment is meaningful interaction with the worktree.
    // Without refreshing lastActivityAt, the time-decay score has decayed
    // since the previous sort, so a re-sort causes the worktree to drop in
    // ranking even though the user just touched it. Bumping the timestamp
    // keeps the recency signal fresh so the worktree holds its position.
    const targetEnriched = resolvedPushTarget
      ? { ...updates, pushTarget: resolvedPushTarget }
      : updates
    const enriched =
      'comment' in targetEnriched
        ? { ...targetEnriched, lastActivityAt: Date.now() }
        : targetEnriched

    let didApply = false
    set((s) => {
      if (shouldApplyUpdate && !shouldApplyUpdate(findKnownWorktreeById(s, worktreeId))) {
        return {}
      }
      didApply = true
      const nextWorktrees = applyWorktreeUpdates(s.worktreesByRepo, worktreeId, enriched)
      const nextDetectedWorktrees = applyDetectedWorktreeUpdates(
        s.detectedWorktreesByRepo,
        worktreeId,
        enriched
      )
      const cacheKey =
        reviewRepo && reviewBranch
          ? getHostedReviewCacheKey(
              reviewRepo.path,
              reviewBranch,
              s.settings,
              reviewRepo.id,
              reviewRepo.connectionId
            )
          : null
      const prCacheKey =
        reviewRepo && reviewBranch
          ? getGitHubPRCacheKey(
              reviewRepo.path,
              reviewRepo.id,
              reviewBranch,
              s.settings,
              reviewRepo.connectionId
            )
          : null
      const prCacheKeys =
        reviewRepo && reviewBranch
          ? [
              prCacheKey,
              getLegacyGitHubPRCacheKey(reviewRepo.path, reviewRepo.id, reviewBranch),
              getLegacyGitHubPRCacheKey(reviewRepo.path, undefined, reviewBranch)
            ].filter((key): key is string => Boolean(key))
          : []
      const hostedReviewCache = s.hostedReviewCache ?? {}
      const prCache = s.prCache ?? {}
      if (
        nextWorktrees === s.worktreesByRepo &&
        nextDetectedWorktrees === s.detectedWorktreesByRepo &&
        !cacheKey &&
        !prCacheKey
      ) {
        return {}
      }

      const nextHostedReviewCache =
        cacheKey && hostedReviewCache[cacheKey]
          ? (() => {
              const next = { ...hostedReviewCache }
              delete next[cacheKey]
              return next
            })()
          : hostedReviewCache
      const nextPRCache = prCacheKeys.some((key) => prCache[key])
        ? (() => {
            const next = { ...prCache }
            for (const key of prCacheKeys) {
              delete next[key]
            }
            return next
          })()
        : prCache

      return {
        ...(nextWorktrees !== s.worktreesByRepo
          ? { worktreesByRepo: nextWorktrees, sortEpoch: s.sortEpoch + 1 }
          : {}),
        ...(nextDetectedWorktrees !== s.detectedWorktreesByRepo
          ? { detectedWorktreesByRepo: nextDetectedWorktrees }
          : {}),
        ...(nextHostedReviewCache !== hostedReviewCache
          ? { hostedReviewCache: nextHostedReviewCache }
          : {}),
        ...(nextPRCache !== prCache ? { prCache: nextPRCache } : {})
      }
    })
    if (shouldApplyUpdate && !didApply) {
      return
    }

    try {
      await persistWorktreeMeta(get().settings, worktreeId, enriched)
      if (reviewRepo && reviewBranch && typeof get().fetchHostedReviewForBranch === 'function') {
        // Why: the old cache entry may have been populated solely by linkedPR.
        // Force a no-linked refetch so an in-flight linked lookup cannot keep
        // showing the manually removed PR.
        void get().fetchHostedReviewForBranch(reviewRepo.path, reviewBranch, {
          repoId: reviewRepo.id,
          linkedGitHubPR: null,
          linkedGitLabMR: worktreeForUpdate?.linkedGitLabMR ?? null,
          force: true
        })
      }
    } catch (err) {
      if (isRuntimeSelectorNotFoundError(err)) {
        void get().fetchWorktrees(getRepoIdFromWorktreeId(worktreeId))
        return
      }
      console.error('Failed to update worktree meta:', err)
      void get().fetchWorktrees(getRepoIdFromWorktreeId(worktreeId))
    }
  },

  updateWorktreesMeta: async (updatesByWorktreeId) => {
    if (updatesByWorktreeId.size === 0) {
      return
    }

    set((s) => {
      let nextWorktrees = s.worktreesByRepo
      let nextDetectedWorktrees = s.detectedWorktreesByRepo
      for (const [worktreeId, updates] of updatesByWorktreeId) {
        nextWorktrees = applyWorktreeUpdates(nextWorktrees, worktreeId, updates)
        nextDetectedWorktrees = applyDetectedWorktreeUpdates(
          nextDetectedWorktrees,
          worktreeId,
          updates
        )
      }
      return nextWorktrees === s.worktreesByRepo &&
        nextDetectedWorktrees === s.detectedWorktreesByRepo
        ? {}
        : {
            ...(nextWorktrees !== s.worktreesByRepo
              ? { worktreesByRepo: nextWorktrees, sortEpoch: s.sortEpoch + 1 }
              : {}),
            ...(nextDetectedWorktrees !== s.detectedWorktreesByRepo
              ? { detectedWorktreesByRepo: nextDetectedWorktrees }
              : {})
          }
    })

    const settings = get().settings
    await Promise.all(
      Array.from(updatesByWorktreeId, async ([worktreeId, updates]) => {
        try {
          await persistWorktreeMeta(settings, worktreeId, updates)
        } catch (err) {
          if (isRuntimeSelectorNotFoundError(err)) {
            void get().fetchWorktrees(getRepoIdFromWorktreeId(worktreeId))
            return
          }
          console.error('Failed to update worktree meta:', err)
          void get().fetchWorktrees(getRepoIdFromWorktreeId(worktreeId))
        }
      })
    )
  },

  markWorktreeUnread: (worktreeId) => {
    // Why: terminal attention should remain visible until the user engages
    // with the worktree. Interaction with a pane inside the worktree dismisses
    // the dot via clearWorktreeUnread. Worktree activation via setActiveWorktree
    // also clears isUnread as a side-effect; that path predates this PR and is
    // unaffected here.
    let shouldPersist = false
    const now = Date.now()
    set((s) => {
      const worktree = findKnownWorktreeById(s, worktreeId)
      if (!worktree || worktree.isUnread) {
        return {}
      }
      shouldPersist = true
      const nextWorktrees = applyWorktreeUpdates(s.worktreesByRepo, worktreeId, {
        isUnread: true,
        lastActivityAt: now
      })
      const nextDetectedWorktrees = applyDetectedWorktreeUpdates(
        s.detectedWorktreesByRepo,
        worktreeId,
        {
          isUnread: true,
          lastActivityAt: now
        }
      )
      return {
        ...(nextWorktrees !== s.worktreesByRepo
          ? { worktreesByRepo: nextWorktrees, sortEpoch: s.sortEpoch + 1 }
          : {}),
        ...(nextDetectedWorktrees !== s.detectedWorktreesByRepo
          ? { detectedWorktreesByRepo: nextDetectedWorktrees }
          : {})
      }
    })

    if (!shouldPersist) {
      return
    }

    void persistWorktreeMeta(get().settings, worktreeId, {
      isUnread: true,
      lastActivityAt: now
    }).catch((err) => {
      if (isRuntimeSelectorNotFoundError(err)) {
        void get().fetchWorktrees(getRepoIdFromWorktreeId(worktreeId))
        return
      }
      console.error('Failed to persist unread worktree state:', err)
      void get().fetchWorktrees(getRepoIdFromWorktreeId(worktreeId))
    })
  },

  observeTerminalGitHubPullRequestLink: (worktreeId, link) => {
    const state = get()
    const worktree = findKnownWorktreeById(state, worktreeId)
    if (!worktree || worktree.isBare || worktree.isArchived) {
      return
    }
    const repo = state.repos.find((candidate) => candidate.id === worktree.repoId)
    if (!repo || (repo.kind && repo.kind !== 'git')) {
      return
    }
    if (typeof worktree.linkedPR === 'number' && worktree.linkedPR !== link.number) {
      return
    }

    const branch = branchName(worktree.branch)
    const alreadyLinked = worktree.linkedPR === link.number

    const fetchPRForBranch = get().fetchPRForBranch
    if (typeof fetchPRForBranch === 'function') {
      void fetchPRForBranch(repo.path, branch, {
        force: true,
        repoId: repo.id,
        linkedPRNumber: alreadyLinked ? link.number : null,
        fallbackPRNumber: null,
        fallbackPRSource: alreadyLinked ? null : 'explicit'
      }).then((pr) => {
        if (!alreadyLinked && pr?.number === link.number) {
          // Why: terminal output can include arbitrary PR URLs from docs,
          // agents, or logs. Persist only after branch lookup confirms it and
          // the user has not picked a different PR while lookup was in flight.
          void get().updateWorktreeMeta(
            worktreeId,
            { linkedPR: link.number },
            {
              shouldApply: (currentWorktree) =>
                Boolean(
                  currentWorktree &&
                  !currentWorktree.isBare &&
                  !currentWorktree.isArchived &&
                  (currentWorktree.linkedPR == null || currentWorktree.linkedPR === link.number)
                )
            }
          )
        }
      })
      return
    }

    const fetchHostedReviewForBranch = get().fetchHostedReviewForBranch
    if (typeof fetchHostedReviewForBranch === 'function') {
      // Why: full app stores always have fetchPRForBranch, which syncs the
      // GitHub hosted-review cache. Keep this only as a slice-test fallback.
      void refreshHostedReviewCard(fetchHostedReviewForBranch, {
        repoPath: repo.path,
        repoId: repo.id,
        branch,
        linkedGitHubPR: alreadyLinked ? link.number : null,
        fallbackGitHubPR: null,
        linkedGitLabMR: worktree.linkedGitLabMR ?? null
      })
    }
  },

  clearWorktreeUnread: (worktreeId) => {
    let shouldPersist = false
    set((s) => {
      const worktree = findKnownWorktreeById(s, worktreeId)
      if (!worktree || !worktree.isUnread) {
        // Why: return `s` (not `{}`) to preserve the exact object reference
        // on no-op. This matches the sibling `clearTerminalTabUnread` in
        // terminals.ts and avoids downstream selector churn on the hot path
        // (called on every keystroke and pointerdown).
        return s
      }
      shouldPersist = true
      const nextWorktrees = applyWorktreeUpdates(s.worktreesByRepo, worktreeId, {
        isUnread: false
      })
      const nextDetectedWorktrees = applyDetectedWorktreeUpdates(
        s.detectedWorktreesByRepo,
        worktreeId,
        {
          isUnread: false
        }
      )
      return {
        ...(nextWorktrees !== s.worktreesByRepo ? { worktreesByRepo: nextWorktrees } : {}),
        ...(nextDetectedWorktrees !== s.detectedWorktreesByRepo
          ? { detectedWorktreesByRepo: nextDetectedWorktrees }
          : {})
      }
    })

    if (!shouldPersist) {
      return
    }

    void persistWorktreeMeta(get().settings, worktreeId, { isUnread: false }).catch((err) => {
      if (isRuntimeSelectorNotFoundError(err)) {
        void get().fetchWorktrees(getRepoIdFromWorktreeId(worktreeId))
        return
      }
      console.error('Failed to persist cleared unread worktree state:', err)
      void get().fetchWorktrees(getRepoIdFromWorktreeId(worktreeId))
    })
  },

  bumpWorktreeActivity: (worktreeId) => {
    const now = Date.now()
    let shouldPersist = false
    set((s) => {
      const worktree = findKnownWorktreeById(s, worktreeId)
      if (!worktree) {
        return {}
      }
      shouldPersist = true
      // Skip sortEpoch bump for the active worktree. Terminal events
      // (PTY spawn, PTY exit) in the active worktree are side-effects of
      // the user clicking the card or interacting with the terminal —
      // re-sorting the sidebar in response would cause the exact reorder-
      // on-click bug PR #209 intended to fix (e.g. dead-PTY reconnection
      // after generation bump triggers updateTabPtyId → here).
      // The lastActivityAt timestamp is still persisted so that the NEXT
      // meaningful sortEpoch bump (from a background worktree event) will
      // include this worktree's updated smart-sort score.
      const isActive = s.activeWorktreeId === worktreeId
      const nextWorktrees = applyWorktreeUpdates(s.worktreesByRepo, worktreeId, {
        lastActivityAt: now
      })
      const nextDetectedWorktrees = applyDetectedWorktreeUpdates(
        s.detectedWorktreesByRepo,
        worktreeId,
        {
          lastActivityAt: now
        }
      )
      return {
        ...(nextWorktrees !== s.worktreesByRepo
          ? {
              worktreesByRepo: nextWorktrees,
              ...(isActive ? {} : { sortEpoch: s.sortEpoch + 1 })
            }
          : {}),
        ...(nextDetectedWorktrees !== s.detectedWorktreesByRepo
          ? { detectedWorktreesByRepo: nextDetectedWorktrees }
          : {})
      }
    })

    if (!shouldPersist) {
      return
    }

    void persistWorktreeMeta(get().settings, worktreeId, { lastActivityAt: now }).catch((err) => {
      if (isRuntimeSelectorNotFoundError(err)) {
        return
      }
      console.error('Failed to persist worktree activity timestamp:', err)
      void get().fetchWorktrees(getRepoIdFromWorktreeId(worktreeId))
    })
  },

  markWorktreeVisited: (worktreeId, visitedAt) => {
    // Why: Cmd+J's empty-query ordering needs a focus-recency signal that is
    // distinct from worktree.lastActivityAt (which is driven by background
    // PTY/activity events). Monotonic: CLI- and IPC-driven activations can
    // race, so older timestamps must not regress the stored value. See
    // docs/cmd-j-empty-query-ordering.md.
    set((s) => {
      const now = visitedAt ?? Date.now()
      const prev = s.lastVisitedAtByWorktreeId[worktreeId] ?? 0
      if (!(now > prev)) {
        return {}
      }
      return {
        lastVisitedAtByWorktreeId: {
          ...s.lastVisitedAtByWorktreeId,
          [worktreeId]: now
        }
      }
    })
  },

  pruneLastVisitedTimestamps: () => {
    set((s) => {
      // Why: scope pruning per-repo. SSH-backed repos cannot enumerate
      // worktrees until their connection is established, so at hydration
      // time worktreesByRepo[sshRepoId] is empty/undefined. If we pruned
      // globally based on the union of all repos' worktrees, we would wipe
      // every persisted focus-recency entry for SSH worktrees — precisely
      // the set this feature exists to preserve. Instead, only drop entries
      // whose repo has a populated worktree list: a missing repoId means
      // "not yet hydrated" (defer), a repoId with an empty list after a
      // successful listing means the worktree really is gone (drop).
      // The ssh:state-changed 'connected' handler re-fetches worktrees and
      // a follow-up prune runs from the same site if needed.
      const validIdsByRepo = new Map<string, Set<string>>()
      for (const [repoId, list] of Object.entries(s.worktreesByRepo)) {
        if (s.detectedWorktreesByRepo[repoId]) {
          continue
        }
        validIdsByRepo.set(repoId, new Set(list.map((worktree) => worktree.id)))
      }
      for (const [repoId, result] of Object.entries(s.detectedWorktreesByRepo)) {
        if (result.authoritative) {
          validIdsByRepo.set(repoId, new Set(result.worktrees.map((worktree) => worktree.id)))
        }
      }
      let changed = false
      const next: Record<string, number> = {}
      for (const [id, ts] of Object.entries(s.lastVisitedAtByWorktreeId)) {
        const repoId = getRepoIdFromWorktreeId(id)
        const repoIds = validIdsByRepo.get(repoId)
        if (!repoIds) {
          // Repo not yet hydrated (e.g. SSH not connected). Keep the entry.
          next[id] = ts
          continue
        }
        if (repoIds.has(id)) {
          next[id] = ts
        } else {
          changed = true
        }
      }
      return changed ? { lastVisitedAtByWorktreeId: next } : {}
    })
  },

  seedActiveWorktreeLastVisitedIfMissing: () => {
    set((s) => {
      const id = s.activeWorktreeId
      if (!id) {
        return {}
      }
      if (s.lastVisitedAtByWorktreeId[id] != null) {
        return {}
      }
      return {
        lastVisitedAtByWorktreeId: {
          ...s.lastVisitedAtByWorktreeId,
          [id]: Date.now()
        }
      }
    })
  },

  setActiveWorktree: (worktreeId) => {
    if (worktreeId && shouldDeferActivationTerminalPrep()) {
      markInputQuietSchedulerInput()
    }

    if (get().activeWorktreeId !== worktreeId) {
      moveFocusToRendererBeforeFocusedWebviewHidden()
    }
    const reconciledActiveTabId = worktreeId
      ? get().reconcileWorktreeTabModel(worktreeId).activeRenderableTabId
      : null
    let shouldClearUnread = false
    let shouldPrepareTerminalTabs = false
    let shouldTagTerminalTabs = false
    set((s) => {
      if (!worktreeId) {
        return {
          activeWorktreeId: null
        }
      }

      const worktree = findKnownWorktreeById(s, worktreeId)
      shouldClearUnread = Boolean(worktree?.isUnread)

      // Restore per-worktree editor state
      const restoredFileId = s.activeFileIdByWorktree[worktreeId] ?? null
      const restoredBrowserTabId = s.activeBrowserTabIdByWorktree[worktreeId] ?? null
      const restoredTabType = s.activeTabTypeByWorktree[worktreeId] ?? 'terminal'
      const activeGroupId =
        s.activeGroupIdByWorktree[worktreeId] ?? s.groupsByWorktree[worktreeId]?.[0]?.id ?? null
      const activeGroup = activeGroupId
        ? ((s.groupsByWorktree[worktreeId] ?? []).find((group) => group.id === activeGroupId) ??
          null)
        : null
      const activeUnifiedTabId = reconciledActiveTabId ?? activeGroup?.activeTabId ?? null
      const activeUnifiedTab =
        activeUnifiedTabId != null
          ? ((s.unifiedTabsByWorktree[worktreeId] ?? []).find(
              (tab) =>
                tab.id === activeUnifiedTabId && (!activeGroup || tab.groupId === activeGroup.id)
            ) ?? null)
          : null
      // Verify the restored file still exists in openFiles
      const fileStillOpen = restoredFileId
        ? s.openFiles.some((f) => f.id === restoredFileId && f.worktreeId === worktreeId)
        : false
      const browserTabs = s.browserTabsByWorktree[worktreeId] ?? []
      const browserTabStillOpen = restoredBrowserTabId
        ? browserTabs.some((tab) => tab.id === restoredBrowserTabId)
        : false
      const hasGroupOwnedSurface =
        (s.groupsByWorktree[worktreeId]?.length ?? 0) > 0 || Boolean(s.layoutByWorktree[worktreeId])

      // Why: worktree activation must restore from the reconciled tab-group
      // model first. Split groups are now the ownership model for visible
      // content; if we prefer the legacy activeTabType/browser/file fallbacks
      // when the two models disagree, the renderer can reopen a surface that
      // has no backing unified tab and show a blank worktree.
      let activeFileId: string | null
      let activeBrowserTabId: string | null
      let activeTabType: WorkspaceVisibleTabType
      if (activeUnifiedTab) {
        activeFileId =
          activeUnifiedTab.contentType === 'editor' ||
          activeUnifiedTab.contentType === 'diff' ||
          activeUnifiedTab.contentType === 'conflict-review'
            ? activeUnifiedTab.entityId
            : fileStillOpen
              ? restoredFileId
              : null
        activeBrowserTabId =
          activeUnifiedTab.contentType === 'browser'
            ? activeUnifiedTab.entityId
            : browserTabStillOpen
              ? restoredBrowserTabId
              : (browserTabs[0]?.id ?? null)
        activeTabType = toVisibleTabType(activeUnifiedTab.contentType)
      } else if (hasGroupOwnedSurface) {
        activeFileId = fileStillOpen ? restoredFileId : null
        activeBrowserTabId = browserTabStillOpen
          ? restoredBrowserTabId
          : (browserTabs[0]?.id ?? null)
        activeTabType = 'terminal'
      } else if (restoredTabType === 'terminal') {
        activeFileId = fileStillOpen ? restoredFileId : null
        activeBrowserTabId = browserTabStillOpen
          ? restoredBrowserTabId
          : (browserTabs[0]?.id ?? null)
        activeTabType = 'terminal'
      } else if (restoredTabType === 'browser' && browserTabStillOpen) {
        activeFileId = fileStillOpen ? restoredFileId : null
        activeBrowserTabId = restoredBrowserTabId
        activeTabType = 'browser'
      } else if (restoredTabType === 'editor' && fileStillOpen) {
        activeFileId = restoredFileId
        activeBrowserTabId = browserTabStillOpen
          ? restoredBrowserTabId
          : (browserTabs[0]?.id ?? null)
        activeTabType = 'editor'
      } else if (browserTabStillOpen) {
        activeFileId = null
        activeBrowserTabId = restoredBrowserTabId
        activeTabType = 'browser'
      } else if (fileStillOpen) {
        activeFileId = restoredFileId
        activeBrowserTabId = browserTabs[0]?.id ?? null
        activeTabType = 'editor'
      } else {
        const fallbackFile = s.openFiles.find((f) => f.worktreeId === worktreeId)
        const fallbackBrowserTab = browserTabs[0] ?? null
        activeFileId = fallbackFile?.id ?? null
        activeBrowserTabId = browserTabStillOpen
          ? restoredBrowserTabId
          : (fallbackBrowserTab?.id ?? null)
        activeTabType = fallbackFile ? 'editor' : fallbackBrowserTab ? 'browser' : 'terminal'
      }

      // Why: restore the last-active terminal tab for this worktree so the
      // user returns to the same tab they left, not always the first one.
      const restoredTabId = s.activeTabIdByWorktree[worktreeId] ?? null
      const worktreeTabs = s.tabsByWorktree[worktreeId] ?? []
      const tabStillExists = restoredTabId
        ? worktreeTabs.some((t) => t.id === restoredTabId)
        : false
      const activeTabId =
        activeUnifiedTab?.contentType === 'terminal'
          ? activeUnifiedTab.entityId
          : tabStillExists
            ? restoredTabId
            : (worktreeTabs[0]?.id ?? null)

      // Why: focusing a worktree is not meaningful background activity for the
      // smart sort. Writing lastActivityAt here makes the next unrelated
      // sortEpoch bump reshuffle cards based on what the user merely looked at,
      // which is the "jump after focus" bug reported in Slack. Keep selection
      // side-effects limited to unread clearing; true activity signals such as
      // PTY lifecycle and explicit edits still flow through bumpWorktreeActivity.
      const metaUpdates: Partial<WorktreeMeta> = shouldClearUnread ? { isUnread: false } : {}

      // Why: dead-PTY terminal prep must complete before the workspace shell
      // renders that tab. The shell render is deferred below, so terminal prep
      // can wait for input quiet instead of blocking the activation click.
      //
      // Why pendingActivationSpawn + first-activation check: the first time a
      // worktree is activated in this session, its TerminalPane mounts and
      // each tab's PTY either reattaches (restored session) or fresh-spawns
      // (never visited). Both paths call updateTabPtyId; neither is real
      // activity — they are side-effects of the click. Tag every tab on the
      // FIRST activation so the resulting updateTabPtyId suppresses both the
      // activity bump and the sortEpoch bump.
      //
      // We can't use tab.ptyId==null as the guard (what the old `allDead`
      // check did): reconnectPersistedTerminals re-populates tab.ptyId with
      // restored daemon session IDs *before* the pane mounts, so tabs look
      // live to allDead even though the next updateTabPtyId is a reattach.
      // Tracking first-activation per worktree is the reliable signal.
      //
      // Generation is still only bumped when tabs have no live PTY — a live
      // tab remount would kill the user's running shell.
      const tabs = s.tabsByWorktree[worktreeId ?? ''] ?? []
      const allDead =
        worktreeId != null &&
        tabs.length > 0 &&
        tabs.every((tab) => !tabHasLivePty(s.ptyIdsByTabId, tab.id))
      const isFirstActivation = worktreeId != null && !s.everActivatedWorktreeIds.has(worktreeId)
      const shouldTagTabs = worktreeId != null && tabs.length > 0 && isFirstActivation
      shouldPrepareTerminalTabs = Boolean(
        worktreeId && tabs.length > 0 && (allDead || shouldTagTabs)
      )
      shouldTagTerminalTabs = shouldTagTabs
      const nextEverActivated = isFirstActivation
        ? new Set([...s.everActivatedWorktreeIds, worktreeId!])
        : s.everActivatedWorktreeIds
      const nextWorktrees = shouldClearUnread
        ? applyWorktreeUpdates(s.worktreesByRepo, worktreeId, metaUpdates)
        : s.worktreesByRepo
      const nextDetectedWorktrees = shouldClearUnread
        ? applyDetectedWorktreeUpdates(s.detectedWorktreesByRepo, worktreeId, metaUpdates)
        : s.detectedWorktreesByRepo

      return {
        activeWorktreeId: worktreeId,
        activeFileId,
        activeBrowserTabId,
        activeTabType,
        activeTabTypeByWorktree: { ...s.activeTabTypeByWorktree, [worktreeId]: activeTabType },
        activeTabId,
        everActivatedWorktreeIds: nextEverActivated,
        ...(nextWorktrees !== s.worktreesByRepo ? { worktreesByRepo: nextWorktrees } : {}),
        ...(nextDetectedWorktrees !== s.detectedWorktreesByRepo
          ? { detectedWorktreesByRepo: nextDetectedWorktrees }
          : {})
      }
    })

    if (worktreeId && shouldPrepareTerminalTabs) {
      const prepareTerminalTabs = (): void => {
        pendingActivationTerminalPrepCancels.delete(worktreeId)
        set((s) => {
          if (s.activeWorktreeId !== worktreeId) {
            return {}
          }
          const tabs = s.tabsByWorktree[worktreeId] ?? []
          if (tabs.length === 0) {
            return {}
          }
          const allDead = tabs.every((tab) => !tabHasLivePty(s.ptyIdsByTabId, tab.id))
          if (!allDead && !shouldTagTerminalTabs) {
            return {}
          }
          return {
            tabsByWorktree: {
              ...s.tabsByWorktree,
              [worktreeId]: tabs.map((tab) => ({
                ...tab,
                ...(allDead ? { generation: (tab.generation ?? 0) + 1 } : {}),
                // Why: slept terminal remount/spawn is click-driven wake work.
                // Tag the resulting PTY updates so they do not reshuffle Recent.
                pendingActivationSpawn: getActivationSpawnSuppression(
                  s.terminalLayoutsByTabId[tab.id]
                )
              }))
            }
          }
        })
      }

      const cancelExistingPrep = pendingActivationTerminalPrepCancels.get(worktreeId)
      if (cancelExistingPrep) {
        cancelExistingPrep()
      }
      if (shouldDeferActivationTerminalPrep()) {
        pendingActivationTerminalPrepCancels.set(
          worktreeId,
          scheduleAfterInputQuiet(prepareTerminalTabs, {
            delayMs: ACTIVE_WORKTREE_TERMINAL_PREP_DELAY_MS,
            quietMs: ACTIVE_WORKTREE_TERMINAL_PREP_INPUT_QUIET_MS,
            idleTimeoutMs: ACTIVE_WORKTREE_TERMINAL_PREP_IDLE_TIMEOUT_MS
          })
        )
      } else {
        prepareTerminalTabs()
      }
    }

    // Why: activation is explicit enough to revalidate PR state immediately;
    // the GitHub coordinator still coalesces requests and applies rate guards.
    if (worktreeId) {
      get().refreshGitHubForWorktreeIfStale(worktreeId)
    }

    if (!worktreeId || !get().getKnownWorktreeById(worktreeId)) {
      return
    }

    if (shouldClearUnread) {
      const updates: Partial<WorktreeMeta> = {
        isUnread: false
      }

      void persistWorktreeMeta(get().settings, worktreeId, updates).catch((err) => {
        if (isRuntimeSelectorNotFoundError(err)) {
          void get().fetchWorktrees(getRepoIdFromWorktreeId(worktreeId))
          return
        }
        console.error('Failed to persist worktree activation state:', err)
        void get().fetchWorktrees(getRepoIdFromWorktreeId(worktreeId))
      })
    }
  },

  allWorktrees: () => Object.values(get().worktreesByRepo).flat(),

  getKnownWorktreeById: (worktreeId) => findKnownWorktreeById(get(), worktreeId),

  purgeWorktreeTerminalState: (worktreeIds: string[]) => {
    if (worktreeIds.length === 0) {
      return
    }
    set((s) => buildWorktreePurgeState(s, worktreeIds))
  }
})
