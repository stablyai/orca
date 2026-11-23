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
import {
  toVisibleTabType,
  type Tab,
  type TabGroup
} from '../../../../../shared/workspace-layout/tab-groups/tab-types'
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

/** The shown creation panel; one that opens a chat draws the chat itself (see AppWorkspaceShell). */
function shownCreation(
  state: VisibleAccountSurfaceState
): { creationId: string; opensChat: boolean } | undefined {
  const creationId = state.activePendingCreationId
  if (!creationId || !selectWorktreeCreationSurfaceShown(state)) {
    return undefined
  }
  const entry = state.pendingWorktreeCreations[creationId]
  return { creationId, opensChat: !!entry && pendingCreationOpensNativeChat(entry) }
}

function focusedWorkspaceTab<T extends Pick<Tab, 'id'>>(
  state: VisibleAccountSurfaceState,
  tabsByWorktree: Record<string, readonly T[]> | undefined,
  workspaceId: string
): T | undefined {
  if (state.activeView !== 'terminal') {
    return undefined
  }
  const groupId = state.activeGroupIdByWorktree?.[workspaceId]
  const group = focusedGroup(state.groupsByWorktree?.[workspaceId], groupId)
  return group?.activeTabId
    ? workspaceTabById(tabsByWorktree?.[workspaceId], group.activeTabId)
    : undefined
}

/** Undefined means no visible workspace; null means visible but ownership is unproven. */
export function visibleAccountHostId(
  state: VisibleAccountSurfaceState
): ExecutionHostId | null | undefined {
  const creation = shownCreation(state)
  if (creation?.opensChat) {
    return pendingChatAccountOwner(state, creation.creationId).hostId
  }
  const workspaceId = state.activeWorktreeId
  if (!workspaceId) {
    return undefined
  }
  const tabHostId = focusedWorkspaceTab(
    state,
    state.unifiedTabsByWorktree,
    workspaceId
  )?.executionHostId
  if (tabHostId) {
    return tabHostId
  }
  return getResolvedExecutionHostIdForWorktree(state, workspaceId)
}

/** True when the focused surface is a chat (agent chat or room), pending or open. */
export function nativeChatSurfaceVisible(
  state: VisibleAccountSurfaceState & {
    unifiedTabsByWorktree?: Record<string, readonly Pick<Tab, 'id' | 'contentType'>[]>
  }
): boolean {
  // A creation panel covers the selected tab, so a chat left selected under it is not visible.
  const creation = shownCreation(state)
  if (creation) {
    return creation.opensChat
  }
  const workspaceId = state.activeWorktreeId
  const tab = workspaceId
    ? focusedWorkspaceTab(state, state.unifiedTabsByWorktree, workspaceId)
    : undefined
  return !!tab && toVisibleTabType(tab.contentType) === 'agent-session'
}
