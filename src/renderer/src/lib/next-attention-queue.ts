import type { AppState } from '@/store/types'
import type { AttentionOrderWorkspace } from '@/components/sidebar/attention-order-workspaces'
import {
  buildExplicitEntriesByTabId,
  collectTabPaneInputs,
  resolveAttention
} from '../../../shared/sidebar-list/smart-attention'
import { collectLeafIds } from '../../../shared/terminal-pane-layout-tree'
import { classifyTitleActivity, isExplicitAgentStatusFresh } from '@/lib/pane-agent-evidence'
import { resolveRuntimePaneTitleLeafId } from '../../../shared/runtime-pane-title-leaf-id'
import { tabHasLivePty } from '../../../shared/tab-has-live-pty'
import { paneKeyTabId } from '@/store/slices/workspace-attention/workspace-live-markers'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry
} from '../../../shared/agent-status-types'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import { structuredAgentSessionPaneKey } from '../../../shared/structured-agent-session-projection'
import { isSyntheticAgentPermissionTitle } from '../../../shared/synthetic-agent-title'
import { composeWorktreeHostIdentity } from '../../../shared/worktree/host-qualified-identity'
import { orderedWorkspaceTabs, type OrderedTab } from './next-attention-tab-order'

/** One place the next-attention shortcut can land, at the deepest level its signal addresses. */
export type AttentionTarget = {
  workspaceIdentity: string
  worktreeId: string
  executionHostId?: ExecutionHostId
  level: 'pane' | 'tab' | 'workspace'
  tabKind?: 'terminal' | 'agent-session'
  /** Unified tab id: picks the exact split copy. */
  unifiedTabId?: string
  /** Terminal entity id, the id pane keys and legacy activation use. */
  terminalTabId?: string
  leafId?: string
  /** Hook status attributed to the workspace whose tab this renderer has not mirrored yet. */
  ownerPaneKey?: string
}

type QueueContext = {
  state: AppState
  now: number
  entriesByTabId: ReadonlyMap<string, AgentStatusEntry[]>
  unreadPaneKeysByTabId: ReadonlyMap<string, string[]>
  mirroredTabIds: ReadonlySet<string>
}

function needsAttention(entry: AgentStatusEntry, hasLivePty: boolean, now: number): boolean {
  return resolveAttention([{ kind: 'hook', entry, hasLivePty }], now).cls === 1
}

function indexUnreadPaneKeys(state: AppState): Map<string, string[]> {
  const byTab = new Map<string, string[]>()
  const markers = [
    ...Object.entries(state.unreadAgentCompletionPanes),
    ...Object.entries(state.unreadTerminalPanes)
  ]
  for (const [paneKey, marker] of markers) {
    if (!marker) {
      continue
    }
    const tabId = paneKeyTabId(paneKey)
    if (tabId !== null) {
      const keys = byTab.get(tabId)
      if (keys) {
        keys.push(paneKey)
      } else {
        byTab.set(tabId, [paneKey])
      }
    }
  }
  return byTab
}

function terminalTabTargets(
  ctx: QueueContext,
  base: Pick<AttentionTarget, 'workspaceIdentity' | 'worktreeId' | 'executionHostId'>,
  entry: Extract<OrderedTab, { kind: 'terminal' }>,
  worktreeLastActivityAt: number
): AttentionTarget[] {
  const { state, now } = ctx
  const tab = entry.terminalTab
  const layout = state.terminalLayoutsByTabId[tab.id]
  const leafOrder = collectLeafIds(layout?.root)
  const leafSet = new Set(leafOrder)
  const hitLeaves = new Set<string>()
  let tabHit = Boolean(state.unreadTerminalTabs[tab.id])
  const markLeaf = (leafId: string | null): void => {
    if (leafId !== null && leafSet.has(leafId)) {
      hitLeaves.add(leafId)
    } else {
      tabHit = true
    }
  }

  const hasLivePty = tabHasLivePty(state.ptyIdsByTabId, tab.id)
  // Same coverage rules as collectTabPaneInputs: any hook hides a synthetic permission title, only a live one a real title.
  const anyHookLeaves = new Set<string>()
  const liveHookLeaves = new Set<string>()
  for (const hook of ctx.entriesByTabId.get(tab.id) ?? []) {
    const leafId = parsePaneKey(hook.paneKey)?.leafId ?? null
    if (leafId !== null) {
      anyHookLeaves.add(leafId)
      if (
        hook.restoredUnconfirmed ||
        isExplicitAgentStatusFresh(hook, now, AGENT_STATUS_STALE_AFTER_MS)
      ) {
        liveHookLeaves.add(leafId)
      }
    }
    if (needsAttention(hook, hasLivePty, now)) {
      markLeaf(leafId)
    }
  }
  const tabPanes = collectTabPaneInputs(
    tab,
    worktreeLastActivityAt,
    {
      entriesByTabId: ctx.entriesByTabId,
      ptyIdsByTabId: state.ptyIdsByTabId,
      runtimePaneTitlesByTabId: state.runtimePaneTitlesByTabId,
      terminalLayoutsByTabId: state.terminalLayoutsByTabId
    },
    now
  )
  const titlePermission = tabPanes.some(
    (pane) => pane.kind === 'title' && pane.status === 'permission'
  )
  if (titlePermission) {
    const titles = Object.entries(state.runtimePaneTitlesByTabId[tab.id] ?? {})
    const permissionLeaves = titles
      .filter(([, title]) => classifyTitleActivity(title) === 'permission')
      .map(([runtimePaneId, title]) => ({
        leafId: resolveRuntimePaneTitleLeafId(layout, runtimePaneId),
        covering: isSyntheticAgentPermissionTitle(title) ? anyHookLeaves : liveHookLeaves
      }))
      .filter(({ leafId, covering }) => leafId === null || !covering.has(leafId))
      .map(({ leafId }) => leafId)
    if (permissionLeaves.length === 0) {
      tabHit = true
    }
    for (const leafId of permissionLeaves) {
      markLeaf(leafId)
    }
  }
  for (const paneKey of ctx.unreadPaneKeysByTabId.get(tab.id) ?? []) {
    markLeaf(parsePaneKey(paneKey)?.leafId ?? null)
  }

  const tabFields = {
    ...base,
    tabKind: 'terminal' as const,
    terminalTabId: tab.id,
    ...(entry.unifiedTabId ? { unifiedTabId: entry.unifiedTabId } : {})
  }
  const paneTargets = leafOrder
    .filter((leafId) => hitLeaves.has(leafId))
    .map((leafId) => ({ ...tabFields, level: 'pane' as const, leafId }))
  if (paneTargets.length > 0) {
    return paneTargets
  }
  return tabHit ? [{ ...tabFields, level: 'tab' }] : []
}

function chatTabTarget(
  ctx: QueueContext,
  base: Pick<AttentionTarget, 'workspaceIdentity' | 'worktreeId' | 'executionHostId'>,
  entry: Extract<OrderedTab, { kind: 'agent-session' }>
): AttentionTarget[] {
  const { state, now } = ctx
  // Why the current session's key only: a tab rebound to a new session no longer owns the old one's markers.
  const paneKey =
    entry.sessionId === null
      ? null
      : structuredAgentSessionPaneKey(entry.unifiedTabId, entry.sessionId)
  const status = paneKey === null ? undefined : state.agentStatusByPaneKey[paneKey]
  const hit =
    Boolean(state.unreadTerminalTabs[entry.unifiedTabId]) ||
    (paneKey !== null &&
      (Boolean(state.unreadAgentCompletionPanes[paneKey]) ||
        Boolean(state.unreadTerminalPanes[paneKey]))) ||
    (status !== undefined && needsAttention(status, false, now))
  return hit
    ? [{ ...base, level: 'tab', tabKind: 'agent-session', unifiedTabId: entry.unifiedTabId }]
    : []
}

/** Every place needing the user, top-to-bottom: sidebar order, then tab strip, then panes. */
export function buildAttentionQueue(
  state: AppState,
  orderedWorkspaces: readonly AttentionOrderWorkspace[],
  now: number
): AttentionTarget[] {
  // Why chat tabs too: a structured chat projects its status under its unified tab id.
  const mirroredTabIds = new Set<string>()
  for (const tabs of [
    ...Object.values(state.tabsByWorktree),
    ...Object.values(state.unifiedTabsByWorktree)
  ]) {
    for (const tab of tabs) {
      mirroredTabIds.add(tab.id)
    }
  }
  const ctx: QueueContext = {
    state,
    now,
    entriesByTabId: buildExplicitEntriesByTabId(
      state.agentStatusByPaneKey,
      state.migrationUnsupportedByPtyId
    ),
    unreadPaneKeysByTabId: indexUnreadPaneKeys(state),
    mirroredTabIds
  }
  const queue: AttentionTarget[] = []
  const seenWorkspaces = new Set<string>()
  // Tab maps key by bare worktree id, so one host's tabs would otherwise repeat under its same-id twin.
  const tabsClaimedBy = new Set<string>()
  for (const workspace of orderedWorkspaces) {
    const workspaceIdentity = composeWorktreeHostIdentity(workspace.identityHostId, workspace.id)
    if (seenWorkspaces.has(workspaceIdentity)) {
      continue
    }
    seenWorkspaces.add(workspaceIdentity)
    const ownsTabs = !tabsClaimedBy.has(workspace.id)
    tabsClaimedBy.add(workspace.id)
    queue.push(...workspaceTargets(ctx, workspace, workspaceIdentity, ownsTabs))
  }
  return queue
}

function workspaceTargets(
  ctx: QueueContext,
  workspace: AttentionOrderWorkspace,
  workspaceIdentity: string,
  ownsTabs: boolean
): AttentionTarget[] {
  const { state, now } = ctx
  const base = {
    workspaceIdentity,
    worktreeId: workspace.id,
    ...(workspace.executionHostId ? { executionHostId: workspace.executionHostId } : {})
  }
  const targets: AttentionTarget[] = []
  for (const tab of ownsTabs ? orderedWorkspaceTabs(state, workspace.id) : []) {
    targets.push(
      ...(tab.kind === 'terminal'
        ? terminalTabTargets(ctx, base, tab, workspace.lastActivityAt)
        : chatTabTarget(ctx, base, tab))
    )
  }
  if (targets.length > 0) {
    return targets
  }
  // Why: a hook stamp can precede the tab's mirroring here; the owner still knows which pane it means.
  const unmirrored = Object.values(ownsTabs ? state.agentStatusByPaneKey : {}).find((entry) => {
    const tabId = parsePaneKey(entry.paneKey)?.tabId
    return (
      entry.worktreeId === workspace.id &&
      tabId !== undefined &&
      !ctx.mirroredTabIds.has(tabId) &&
      needsAttention(entry, false, now)
    )
  })
  if (unmirrored) {
    return [{ ...base, level: 'workspace', ownerPaneKey: unmirrored.paneKey }]
  }
  return workspace.isUnread ? [{ ...base, level: 'workspace' }] : []
}
