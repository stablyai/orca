import { collectLeafIdsInOrder } from '@/components/terminal-pane/layout-serialization'
import { resolveAgentPaneAuthorityKey } from '@/store/slices/agent-pane-authority'
import type { AppState } from '../../store/types'
import { titleHasAgentName } from '../../../../shared/agent-detection'
import type {
  AgentStatusIpcPayload,
  ParsedAgentStatusPayload
} from '../../../../shared/agent-status-types'
import { makePaneKey, parsePaneKey } from '../../../../shared/stable-pane-id'
import { getRepoMapFromState, getWorktreeMapFromState } from '@/store/selectors'
import type { useAppStore } from '../../store'

export function isAgentStatusForRecentlyClosedTab(
  store: Pick<AppState, 'recentlyClosedAgentStatusTabIds' | 'recentlyRetiredAgentStatusPaneKeys'>,
  paneKey: string
): boolean {
  const ownerPaneKey = resolveAgentPaneAuthorityKey(paneKey)
  if (store.recentlyRetiredAgentStatusPaneKeys?.[ownerPaneKey] === true) {
    return true
  }
  const tabId = parsePaneKey(ownerPaneKey)?.tabId
  return tabId ? store.recentlyClosedAgentStatusTabIds[tabId] === true : false
}

export function hasRuntimeBackedWorktreeAttribution(data: AgentStatusIpcPayload): boolean {
  return (
    (typeof data.terminalHandle === 'string' && data.terminalHandle.length > 0) ||
    data.orchestration !== undefined
  )
}

export function tryMakePaneKey(tabId: string, leafId: string): string | null {
  try {
    return makePaneKey(tabId, leafId)
  } catch {
    return null
  }
}

export function applyResolvedAgentTerminalTitleToTab(
  store: ReturnType<typeof useAppStore.getState>,
  paneKey: string,
  previousTitle: string | undefined,
  nextTitle: string | undefined
): void {
  if (
    !nextTitle ||
    !shouldApplyResolvedAgentTerminalTitleToTab(store, paneKey, previousTitle, nextTitle)
  ) {
    return
  }
  const parsed = parsePaneKey(paneKey)
  if (!parsed) {
    return
  }
  // Why: hook completion can arrive while the pane transport is unmounted; keep the tab label synced to the resolved state title.
  store.updateTabTitle(parsed.tabId, nextTitle)
}

export function shouldApplyResolvedAgentTerminalTitleToTab(
  store: ReturnType<typeof useAppStore.getState>,
  paneKey: string,
  previousTitle: string | undefined,
  nextTitle: string | undefined
): boolean {
  if (!nextTitle || nextTitle === previousTitle) {
    return false
  }
  const parsed = parsePaneKey(paneKey)
  if (!parsed) {
    return false
  }
  const layout = store.terminalLayoutsByTabId?.[parsed.tabId]
  if (layout?.root && layout.activeLeafId && layout.activeLeafId !== parsed.leafId) {
    return false
  }
  return true
}

/** Resolve a paneKey (tabId:leafId) to liveness, current title, owning worktree,
 *  and the owning repo's connectionId. Used for agent-type inference and to drop
 *  status updates for torn-down tabs or dead connections (an SSH reconnect retires the
 *  old connectionId, so events still in flight under it must not land). */
export function resolvePaneKey(
  store: ReturnType<typeof useAppStore.getState>,
  paneKey: string
): {
  exists: boolean
  title: string | undefined
  identityTitle: string | undefined
  repoConnectionId: string | null
  repoConnectionResolved: boolean
  owningWorktreeId: string | undefined
  titleUsesTabTitle: boolean
} {
  const parsed = parsePaneKey(paneKey)
  if (!parsed) {
    return {
      exists: false,
      title: undefined,
      identityTitle: undefined,
      repoConnectionId: null,
      repoConnectionResolved: false,
      owningWorktreeId: undefined,
      titleUsesTabTitle: false
    }
  }
  const { tabId, leafId } = parsed
  const layout = store.terminalLayoutsByTabId?.[tabId]
  let exists = false
  let tabTitle: string | undefined
  let unifiedTabLabel: string | undefined
  let owningWorktreeId: string | undefined
  for (const [worktreeId, tabs] of Object.entries(store.tabsByWorktree)) {
    for (const tab of tabs) {
      if (tab.id === tabId) {
        exists = true
        tabTitle = tab.title
        owningWorktreeId = worktreeId
        const visibleTab = (store.unifiedTabsByWorktree?.[worktreeId] ?? []).find(
          (entry) => entry.contentType === 'terminal' && entry.entityId === tabId
        )
        const rawVisibleLabel = visibleTab?.label?.trim()
        unifiedTabLabel =
          rawVisibleLabel && rawVisibleLabel.length > 0 ? rawVisibleLabel : undefined
        break
      }
    }
    if (exists) {
      break
    }
  }
  // Why: keep "resolved to a local repo" distinct from "not hydrated yet" so callers filter strictly post-hydration but still accept SSH snapshots during the startup ownership gap.
  let repoConnectionId: string | null = null
  let repoConnectionResolved = false
  if (owningWorktreeId !== undefined) {
    const worktree = getWorktreeMapFromState(store).get(owningWorktreeId)
    if (worktree) {
      const repo = getRepoMapFromState(store).get(worktree.repoId)
      repoConnectionResolved = repo !== undefined
      repoConnectionId = repo?.connectionId ?? null
    }
  }
  if (!exists) {
    return {
      exists: false,
      title: undefined,
      identityTitle: undefined,
      repoConnectionId,
      repoConnectionResolved,
      owningWorktreeId,
      titleUsesTabTitle: false
    }
  }
  // Why: an empty layout snapshot from a worktree switch (tab/PTY still live) counts as missing metadata; a non-empty layout lacking the leaf still means closed.
  const leafExists = layout?.root ? collectLeafIdsInOrder(layout.root).includes(leafId) : true
  if (!leafExists) {
    return {
      exists: false,
      title: undefined,
      identityTitle: undefined,
      repoConnectionId,
      repoConnectionResolved,
      owningWorktreeId,
      titleUsesTabTitle: false
    }
  }
  // Why: inactive worktrees can have a durable tab and live PTY while the layout is unmounted; hook state must still land there.
  const rawPaneTitle = layout?.titlesByLeafId?.[leafId]
  // Why: treat empty-string paneTitle as "no title" so the tab-level fallback fires; nullish-coalescing on '' would short-circuit and erase cached terminalTitle.
  const paneTitle = rawPaneTitle && rawPaneTitle.length > 0 ? rawPaneTitle : undefined
  return {
    exists,
    title: paneTitle ?? tabTitle,
    // Why: some agents (OpenClaude) keep the terminal title generic while the tab label carries the agent identity; use only the non-custom label for attribution.
    identityTitle: paneTitle ?? unifiedTabLabel ?? tabTitle,
    repoConnectionId,
    repoConnectionResolved,
    owningWorktreeId,
    titleUsesTabTitle: paneTitle === undefined
  }
}

export function resolveWorktreeConnection(
  store: ReturnType<typeof useAppStore.getState>,
  worktreeId: string
): {
  worktreeExists: boolean
  repoConnectionId: string | null
  repoConnectionResolved: boolean
} {
  const worktree = getWorktreeMapFromState(store).get(worktreeId)
  if (!worktree) {
    return { worktreeExists: false, repoConnectionId: null, repoConnectionResolved: false }
  }
  const repo = getRepoMapFromState(store).get(worktree.repoId)
  return {
    worktreeExists: true,
    repoConnectionId: repo?.connectionId ?? null,
    repoConnectionResolved: repo !== undefined
  }
}

export function resolveHookPayloadAgentType(
  payload: ParsedAgentStatusPayload,
  terminalTitle: string | undefined
): ParsedAgentStatusPayload {
  if (
    payload.agentType !== 'claude' ||
    !terminalTitle ||
    !titleHasAgentName(terminalTitle, 'openclaude')
  ) {
    return payload
  }
  // Why: OpenClaude emits Claude-compatible hooks; the title is the last renderer signal to keep it out of Claude-only status paths.
  return { ...payload, agentType: 'openclaude' }
}
