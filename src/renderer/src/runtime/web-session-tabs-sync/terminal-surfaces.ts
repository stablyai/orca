import { readStructuredAgentLaunchRecord } from '@/lib/agent-session/launch/structured-agent-session-launch-persistence'
import type {
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionAgentTab
} from '../../../../shared/runtime-types'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/terminal-tab-types'
import { defaultAgentChatLabel } from '../../../../shared/agent-session/agent-session-chat-label'
import { sanitizeTerminalLayoutPaneTitlesForLabels } from '../../../../shared/terminal-pane-title-sanitization'
import { resolveTerminalLayoutRoot } from '../remote-terminal-layout-resolution'
import { retainLocalScrollbackInRemoteLayout } from '@/components/terminal-pane/remote-layout-scrollback-retention'
import { getRemoteRuntimePtyEnvironmentId } from '../runtime-terminal-stream'
import {
  HOST_TERMINAL_SURFACE_SEPARATOR,
  WEB_TERMINAL_SURFACE_TAB_PREFIX,
  toWebTerminalSurfaceTabId
} from '../../../../shared/terminal-surface-id'
import type {
  ReadyBrowserSurface,
  ReadyEditorSurface,
  ReadyTerminalSurface,
  TerminalSurface,
  MirroredAgentTab
} from './state'
import type { Tab } from '../../../../shared/tab-types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { structuredAgentSessionTabId } from '../../../../shared/structured-agent-session-projection'
import { hasStructuredAgentSessionLaunchCancellationTombstone } from '@/lib/agent-session/launch/structured-agent-session-launch-registry'
import { withPendingPaneTitleRenames } from '../pending-pane-title-renames'
import {
  isMirroredTerminalOfAnotherEnvironment,
  type MirrorRowOwnershipState
} from './mirror-row-ownership'

export function isReadyTerminalTab(
  tab: RuntimeMobileSessionTabsResult['tabs'][number]
): tab is ReadyTerminalSurface {
  return tab.type === 'terminal' && tab.status === 'ready' && tab.terminal.trim().length > 0
}

export function isTerminalSurfaceTab(
  tab: RuntimeMobileSessionTabsResult['tabs'][number]
): tab is TerminalSurface {
  return tab.type === 'terminal'
}

export function isReadyBrowserTab(
  tab: RuntimeMobileSessionTabsResult['tabs'][number]
): tab is ReadyBrowserSurface {
  return tab.type === 'browser' && typeof tab.browserPageId === 'string' && tab.browserPageId !== ''
}

export function isReadyEditorTab(
  tab: RuntimeMobileSessionTabsResult['tabs'][number]
): tab is ReadyEditorSurface {
  return tab.type === 'markdown' || tab.type === 'file'
}

export function isAgentSessionTab(
  tab: RuntimeMobileSessionTabsResult['tabs'][number]
): tab is RuntimeMobileSessionAgentTab {
  return tab.type === 'agent-session'
}

export function buildMirroredAgentTabs(
  snapshot: RuntimeMobileSessionTabsResult,
  /** The host that published the snapshot; stamped so later operations reach the chat there. */
  executionHostId: ExecutionHostId,
  hostGroupIdByTabId: ReadonlyMap<string, string>,
  fallbackGroupId: string,
  sortOffset: number,
  currentUnifiedTabs: readonly Tab[],
  now: number
): MirroredAgentTab[] {
  const agentTabs = snapshot.tabs
    .filter(isAgentSessionTab)
    .filter(
      (tab) =>
        !hasStructuredAgentSessionLaunchCancellationTombstone(snapshot.worktree, tab.sessionId)
    )
  const occupiedIds = new Set(currentUnifiedTabs.map((tab) => tab.id))
  const assignedIds = new Set<string>()
  const replacementTabs = new Map<string, Tab>()
  const replacementIds = new Set<string>()
  for (const tab of agentTabs) {
    if (!tab.replacesSessionId) {
      continue
    }
    const existing =
      currentUnifiedTabs.find(
        (candidate) =>
          candidate.contentType === 'agent-session' && candidate.entityId === tab.sessionId
      ) ??
      currentUnifiedTabs.find(
        (candidate) =>
          !replacementIds.has(candidate.id) &&
          candidate.contentType === 'agent-session' &&
          candidate.entityId === tab.replacesSessionId
      )
    if (existing) {
      replacementTabs.set(tab.sessionId, existing)
      replacementIds.add(existing.id)
    }
  }
  return agentTabs.map((tab, index) => {
    const existing =
      replacementTabs.get(tab.sessionId) ??
      currentUnifiedTabs.find(
        (candidate) =>
          !replacementIds.has(candidate.id) &&
          candidate.contentType === 'agent-session' &&
          candidate.entityId === tab.sessionId
      )
    const launch = readStructuredAgentLaunchRecord(tab.sessionId)
    const address =
      executionHostId === 'local' &&
      launch?.executionHostId === executionHostId &&
      launch.surfaceAddress?.worktreeId === snapshot.worktree
        ? launch.surfaceAddress
        : undefined
    const baseId = structuredAgentSessionTabId(tab.sessionId)
    let localId = existing?.id ?? baseId
    if (!existing || assignedIds.has(localId)) {
      let suffix = 0
      while (occupiedIds.has(localId)) {
        localId = `${baseId}:history-${++suffix}`
      }
    }
    occupiedIds.add(localId)
    assignedIds.add(localId)
    return {
      hostTabId: tab.id,
      unifiedTab: {
        id: localId,
        entityId: tab.sessionId,
        // Preserve provisional groups on promotion; lagging host placement must not move mounted panes after user splits.
        groupId:
          existing?.groupId ??
          address?.targetGroupId ??
          hostGroupIdByTabId.get(tab.id) ??
          fallbackGroupId,
        worktreeId: snapshot.worktree,
        executionHostId,
        contentType: 'agent-session',
        agentSessionAgent: tab.agent,
        // Wire title can violate its string type; fall back instead of throwing inside store patches.
        label: tab.title?.trim() || defaultAgentChatLabel(tab.agent),
        // Manual rename is client-owned; host snapshots must not null it.
        customLabel: existing?.customLabel ?? null,
        color: tab.color !== undefined ? tab.color : (existing?.color ?? null),
        sortOrder: sortOffset + index,
        createdAt: existing?.createdAt ?? now + sortOffset + index,
        isPinned: tab.isPinned !== undefined ? tab.isPinned : existing?.isPinned === true
      }
    }
  })
}

export function isRuntimeTerminalTabForEnvironment(
  tab: TerminalTab,
  environmentId: string
): boolean {
  if (!tab.ptyId) {
    return false
  }
  return getRemoteRuntimePtyEnvironmentId(tab.ptyId) === environmentId
}

export function isMirroredTerminalSurfaceId(tabId: string): boolean {
  return (
    tabId.startsWith(WEB_TERMINAL_SURFACE_TAB_PREFIX) ||
    tabId.includes(HOST_TERMINAL_SURFACE_SEPARATOR)
  )
}

export function chooseRemoteTerminalLayout(
  surfaces: readonly TerminalSurface[],
  ptyIdsByLeafId: Record<string, string>,
  existingLayout?: TerminalLayoutSnapshot,
  requestedActiveLeafId?: string
): TerminalLayoutSnapshot {
  const leafIds = surfaces.map((surface) => surface.leafId)
  const knownLeafIds = new Set(leafIds)
  const parentLayoutSource = surfaces.find((surface) => surface.parentLayout)
  const parentLayout = parentLayoutSource?.parentLayout
    ? sanitizeTerminalLayoutPaneTitlesForLabels(parentLayoutSource.parentLayout, [
        parentLayoutSource.title
      ])
    : undefined
  const activeLeafId =
    (requestedActiveLeafId && knownLeafIds.has(requestedActiveLeafId)
      ? requestedActiveLeafId
      : null) ??
    // Why: host title/status snapshots may still mark an agent pane active after this client selected a different split pane.
    (existingLayout?.activeLeafId && knownLeafIds.has(existingLayout.activeLeafId)
      ? existingLayout.activeLeafId
      : null) ??
    (parentLayout?.activeLeafId && knownLeafIds.has(parentLayout.activeLeafId)
      ? parentLayout.activeLeafId
      : null) ??
    surfaces.find((surface) => surface.isActive)?.leafId ??
    leafIds[0] ??
    null
  const expandedLeafId =
    requestedActiveLeafId &&
    (Boolean(existingLayout?.expandedLeafId) || Boolean(parentLayout?.expandedLeafId))
      ? requestedActiveLeafId
      : parentLayout?.expandedLeafId && knownLeafIds.has(parentLayout.expandedLeafId)
        ? parentLayout.expandedLeafId
        : null
  const chatLeafId =
    parentLayout?.chatLeafId && knownLeafIds.has(parentLayout.chatLeafId)
      ? parentLayout.chatLeafId
      : existingLayout?.chatLeafId && knownLeafIds.has(existingLayout.chatLeafId)
        ? existingLayout.chatLeafId
        : undefined
  // Host owns structure but publishes no scrollback. Carry client bytes only for surviving host-named leaves or inventory between park/reveal drops the only copy.
  const titlesByLeafId = withPendingPaneTitleRenames(parentLayout?.titlesByLeafId, leafIds)
  return retainLocalScrollbackInRemoteLayout(existingLayout, {
    // Why: host parentLayout is authoritative for split direction; else keep the prior client tree — a leaf-set mismatch prunes/grafts it, never re-guesses the directions it already carries.
    root: resolveTerminalLayoutRoot({
      authoritativeRoot: parentLayout?.root,
      existingRoot: existingLayout?.root,
      leafIds,
      onSynthesize: (leafCount) =>
        console.warn(
          `[web-session-tabs-sync] synthesized a split direction for ${leafCount} leaves no authoritative or prior tree placed`
        )
    }),
    activeLeafId,
    expandedLeafId,
    ...(chatLeafId ? { chatLeafId } : {}),
    ptyIdsByLeafId,
    // Why: surface.title is the tab/PTY label, not a pane title; restoring it as one renders a fake title bar. Only host layout titles are real pane titles.
    ...(titlesByLeafId ? { titlesByLeafId } : {})
  })
}

export function shouldReplaceTerminalTab(
  state: MirrorRowOwnershipState,
  tab: TerminalTab,
  environmentId: string,
  nextRemotePtyIds: ReadonlySet<string>,
  nextMirroredTerminalIds: ReadonlySet<string>,
  exactProvisionalHandoffs: ReadonlySet<string>,
  persistedLeafPtyIds: Readonly<Record<string, string>> | undefined
): boolean {
  if (exactProvisionalHandoffs.has(tab.id)) {
    // Agent kind is not identity; retire only provisional requests/responses matching this exact host surface.
    return true
  }
  if (isMirroredTerminalSurfaceId(tab.id)) {
    // Why: host snapshots are authoritative for their own mirrored tabs; replace them even when the next surface still awaits a stream handle, else parity drifts.
    return (
      nextMirroredTerminalIds.has(tab.id) ||
      !isMirroredTerminalOfAnotherEnvironment(state, tab, environmentId)
    )
  }
  if (tab.pendingActivationSpawn && tab.ptyId === null && nextRemotePtyIds.size > 0) {
    // Fresh placeholders lack identity; restored rows may retire only when their own PTYs arrive (#25339).
    return (
      !tab.restoredFromSession ||
      nextMirroredTerminalIds.has(toWebTerminalSurfaceTabId(tab.id)) ||
      Object.values(persistedLeafPtyIds ?? {}).some((ptyId) => nextRemotePtyIds.has(ptyId))
    )
  }
  if (!isRuntimeTerminalTabForEnvironment(tab, environmentId)) {
    return false
  }
  // Why: web-created remote tabs use local UUIDs until the host publishes their surface; only retire them once their PTY appears in the snapshot.
  return (
    tab.ptyId !== null &&
    (nextRemotePtyIds.has(tab.ptyId) ||
      nextMirroredTerminalIds.has(toWebTerminalSurfaceTabId(tab.id)))
  )
}
