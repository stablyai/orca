import type {
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionAgentTab
} from '../../../../shared/runtime-types'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/terminal-tab-types'
import { sanitizeTerminalLayoutPaneTitlesForLabels } from '@/lib/terminal-pane-title-sanitization'
import { resolveTerminalLayoutRoot } from '../remote-terminal-layout-resolution'
import { getRemoteRuntimePtyEnvironmentId } from '../runtime-terminal-stream'
import {
  HOST_TERMINAL_SURFACE_SEPARATOR,
  WEB_TERMINAL_SURFACE_TAB_PREFIX,
  toWebTerminalSurfaceTabId
} from '../web-runtime-session'
import type {
  ReadyBrowserSurface,
  ReadyEditorSurface,
  ReadyTerminalSurface,
  TerminalSurface,
  MirroredAgentTab
} from './state'
import type { Tab } from '../../../../shared/tab-types'
import { structuredAgentSessionTabId } from '../../../../shared/structured-agent-session-projection'

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
  hostGroupIdByTabId: ReadonlyMap<string, string>,
  fallbackGroupId: string,
  sortOffset: number,
  currentUnifiedTabs: readonly Tab[],
  now: number
): MirroredAgentTab[] {
  return snapshot.tabs.filter(isAgentSessionTab).map((tab, index) => {
    const localId = structuredAgentSessionTabId(tab.sessionId)
    const existing = currentUnifiedTabs.find(
      (candidate) => candidate.contentType === 'agent-session' && candidate.id === localId
    )
    return {
      hostTabId: tab.id,
      unifiedTab: {
        id: localId,
        entityId: tab.sessionId,
        groupId: hostGroupIdByTabId.get(tab.id) ?? fallbackGroupId,
        worktreeId: snapshot.worktree,
        contentType: 'agent-session',
        agentSessionAgent: tab.agent,
        label: tab.title.trim() || 'Codex Chat',
        customLabel: null,
        color: tab.color !== undefined ? tab.color : (existing?.color ?? null),
        sortOrder: sortOffset + index,
        createdAt: existing?.createdAt ?? now + sortOffset + index,
        isPinned: tab.isPinned !== undefined ? tab.isPinned : existing?.isPinned === true
      }
    }
  })
}

export function localEditorFileId(tab: ReadyEditorSurface): string {
  if (tab.type === 'markdown' && tab.mode === 'markdown-preview') {
    return `markdown-preview::${tab.sourceFilePath}`
  }
  return tab.filePath
}

export function editorSourceFileId(tab: ReadyEditorSurface): string | undefined {
  return tab.type === 'markdown' && tab.mode === 'markdown-preview' ? tab.sourceFilePath : undefined
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
  return {
    // Why: host parentLayout is authoritative for split direction; else keep the prior client tree, then degenerate — never re-guess a direction.
    root: resolveTerminalLayoutRoot({
      authoritativeRoot: parentLayout?.root,
      existingRoot: existingLayout?.root,
      leafIds,
      onSynthesize: (leafCount) =>
        console.warn(
          `[web-session-tabs-sync] synthesized layout for ${leafCount} leaves; no authoritative or prior tree covered them`
        )
    }),
    activeLeafId,
    expandedLeafId,
    ptyIdsByLeafId,
    // Why: surface.title is the tab/PTY label, not a pane title; restoring it as one renders a fake title bar. Only host layout titles are real pane titles.
    ...(parentLayout?.titlesByLeafId ? { titlesByLeafId: parentLayout.titlesByLeafId } : {})
  }
}

export function shouldReplaceTerminalTab(
  tab: TerminalTab,
  environmentId: string,
  nextRemotePtyIds: ReadonlySet<string>,
  nextMirroredTerminalIds: ReadonlySet<string>,
  exactProvisionalHandoffs: ReadonlySet<string>
): boolean {
  if (exactProvisionalHandoffs.has(tab.id)) {
    // Why: agent kind is not session identity; retire only the provisional tab
    // whose request or structured response identifies this exact host surface.
    return true
  }
  if (isMirroredTerminalSurfaceId(tab.id)) {
    // Why: host snapshots are authoritative for mirrored tabs; replace old mirrors even when the next surface still awaits a stream handle, else parity drifts.
    return true
  }
  if (tab.pendingActivationSpawn && tab.ptyId === null && nextRemotePtyIds.size > 0) {
    return true
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
