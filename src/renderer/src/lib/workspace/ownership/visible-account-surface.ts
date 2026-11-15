import { workspaceTabById } from '@/lib/agent-session/tab-identity/structured-chat-tab-index'
import {
  getRepoExecutionHostId,
  type ExecutionHostId
} from '../../../../../shared/execution-host/execution-host'
import { getRepoMainWorktreeId } from '../../../../../shared/worktree/id'
import { pendingCreationOpensNativeChat } from '../creation/pending-worktree-creation'
import { selectWorktreeCreationSurfaceShown } from '../creation/worktree-creation-surface'
import {
  resolveIndexedRepoOwner,
  resolveQualifiedIndexedRepoOwnerForHost,
  findIndexedRepoOwnerForHost
} from './repo-owner-index'
import { getResolvedExecutionHostIdForWorktree } from './resolved-worktree-execution-host'
import type { AppState } from '@/store/types'
import type { Tab, TabGroup } from '../../../../../shared/workspace-layout/tab-groups/tab-types'
import type { WorktreeRuntimeOwnerState } from './worktree-runtime-owner-state'

export type VisibleAccountSurfaceState = WorktreeRuntimeOwnerState &
  Pick<AppState, 'activeView' | 'activePendingCreationId' | 'pendingWorktreeCreations'> & {
    activeGroupIdByWorktree?: Record<string, string>
    groupsByWorktree?: Record<string, readonly Pick<TabGroup, 'id' | 'activeTabId'>[]>
    unifiedTabsByWorktree?: Record<string, readonly Pick<Tab, 'id' | 'executionHostId'>[]>
  }

type SurfaceGroup = Pick<TabGroup, 'id' | 'activeTabId'>
const groupIndexes = new WeakMap<readonly SurfaceGroup[], ReadonlyMap<string, SurfaceGroup>>()

function focusedGroup(groups: readonly SurfaceGroup[] | undefined, id: string | undefined) {
  if (!groups || !id) {
    return undefined
  }
  let index = groupIndexes.get(groups)
  if (!index) {
    index = new Map(groups.map((group) => [group.id, group]))
    groupIndexes.set(groups, index)
  }
  return index.get(id)
}

export type AccountSurfaceOwner = {
  hostId: ExecutionHostId | null
  sourceWorktreeId?: string
}

export function pendingChatAccountOwner(
  state: VisibleAccountSurfaceState,
  creationId: string
): AccountSurfaceOwner {
  const entry = state.pendingWorktreeCreations[creationId]
  if (!entry) {
    return { hostId: null }
  }
  const request = entry.request
  const explicit = request.executionHostId ?? request.workspaceRunContext?.hostId
  const repo = explicit
    ? resolveQualifiedIndexedRepoOwnerForHost(state.repos, request.repoId, explicit)
    : resolveIndexedRepoOwner(state.repos, request.repoId)
  const hostId = explicit ?? (repo.kind === 'resolved' ? getRepoExecutionHostId(repo.owner) : null)
  const source =
    hostId && repo.kind === 'resolved'
      ? findIndexedRepoOwnerForHost(state.repos, request.repoId, hostId)
      : null
  return {
    hostId,
    ...(source?.path
      ? { sourceWorktreeId: getRepoMainWorktreeId({ id: source.id, path: source.path }) }
      : {})
  }
}

/** Undefined means no visible workspace; null means visible but ownership is unproven. */
export function visibleAccountHostId(
  state: VisibleAccountSurfaceState
): ExecutionHostId | null | undefined {
  const creationId = state.activePendingCreationId
  if (creationId && selectWorktreeCreationSurfaceShown(state)) {
    const entry = state.pendingWorktreeCreations[creationId]
    if (entry && pendingCreationOpensNativeChat(entry)) {
      return pendingChatAccountOwner(state, creationId).hostId
    }
  }
  const workspaceId = state.activeWorktreeId
  if (!workspaceId) {
    return undefined
  }
  if (state.activeView === 'terminal') {
    const groupId = state.activeGroupIdByWorktree?.[workspaceId]
    const group = focusedGroup(state.groupsByWorktree?.[workspaceId], groupId)
    const tab = group?.activeTabId
      ? workspaceTabById(state.unifiedTabsByWorktree?.[workspaceId], group.activeTabId)
      : undefined
    if (tab?.executionHostId) {
      return tab.executionHostId
    }
  }
  return getResolvedExecutionHostIdForWorktree(state, workspaceId)
}

export function visibleAccountSurfaceKey(state: VisibleAccountSurfaceState): string {
  const creationId = state.activePendingCreationId
  if (
    creationId &&
    selectWorktreeCreationSurfaceShown(state) &&
    state.pendingWorktreeCreations[creationId] &&
    pendingCreationOpensNativeChat(state.pendingWorktreeCreations[creationId])
  ) {
    return `pending:${creationId}`
  }
  const workspaceId = state.activeWorktreeId
  const group = workspaceId
    ? focusedGroup(
        state.groupsByWorktree?.[workspaceId],
        state.activeGroupIdByWorktree?.[workspaceId]
      )
    : undefined
  return `${workspaceId ?? ''}:${group?.id ?? ''}:${group?.activeTabId ?? ''}`
}
