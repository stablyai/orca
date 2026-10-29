import type { AppState } from '@/store'
import type { TerminalLeafMoveResult } from '../../../../shared/terminal-leaf-move'
import { requestBackgroundTerminalWorktreeMount } from '../terminal/background-terminal-worktree-mount'
import { BACKGROUND_WORKTREE_MEASURE_WINDOW_MS } from '../terminal/background-terminal-worktree-visibility'
import { leaseTerminalPaneMount } from './terminal-pane-split-request-routing'

/** A pane another client moved to a new tab, under the tab id that client drew. */
export type TerminalPaneMoveToNewTabTarget = {
  leafId: string
  targetTabId: string
  targetGroupId?: string
  index?: number
}

type TerminalPaneMoveHandler = (
  move: TerminalPaneMoveToNewTabTarget
) => Promise<{ ptyId: string | null } | null>

const handlersByTab = new Map<string, TerminalPaneMoveHandler>()
const registrationListeners = new Set<() => void>()

function tabKey(worktreeId: string, tabId: string): string {
  return `${worktreeId}\0${tabId}`
}

export function registerTerminalPaneMoveToNewTabHandler(
  worktreeId: string,
  tabId: string,
  handler: TerminalPaneMoveHandler
): () => void {
  const key = tabKey(worktreeId, tabId)
  handlersByTab.set(key, handler)
  for (const listener of registrationListeners) {
    listener()
  }
  return () => {
    // React can mount a replacement before the old effect cleans up.
    if (handlersByTab.get(key) === handler) {
      handlersByTab.delete(key)
    }
  }
}

function mountedHandler(
  worktreeId: string,
  tabId: string
): Promise<TerminalPaneMoveHandler | null> {
  const key = tabKey(worktreeId, tabId)
  const mounted = handlersByTab.get(key)
  if (mounted) {
    return Promise.resolve(mounted)
  }
  // A parked or background tab has no live panes; mount it as a routed split would.
  leaseTerminalPaneMount(tabId, worktreeId)
  requestBackgroundTerminalWorktreeMount({ worktreeId, tabIds: [tabId] })
  return new Promise((resolve) => {
    const settle = (handler: TerminalPaneMoveHandler | null): void => {
      clearTimeout(timer)
      registrationListeners.delete(onRegistered)
      resolve(handler)
    }
    const onRegistered = (): void => {
      const handler = handlersByTab.get(key)
      if (handler) {
        settle(handler)
      }
    }
    const timer = setTimeout(() => settle(null), BACKGROUND_WORKTREE_MEASURE_WINDOW_MS)
    registrationListeners.add(onRegistered)
  })
}

/** The group the moved pane's tab joins: the drop's when this window has it, else its source's. */
export function resolvePaneMoveTargetGroup(
  state: Pick<AppState, 'groupsByWorktree' | 'unifiedTabsByWorktree'>,
  worktreeId: string,
  sourceTabId: string,
  move: Pick<TerminalPaneMoveToNewTabTarget, 'targetGroupId' | 'index'>
): { groupId: string; index?: number } | null {
  const groups = state.groupsByWorktree[worktreeId] ?? []
  if (move.targetGroupId && groups.some((group) => group.id === move.targetGroupId)) {
    return {
      groupId: move.targetGroupId,
      ...(move.index !== undefined ? { index: move.index } : {})
    }
  }
  const sourceGroupId = state.unifiedTabsByWorktree[worktreeId]?.find(
    (tab) => tab.contentType === 'terminal' && tab.entityId === sourceTabId
  )?.groupId
  return sourceGroupId ? { groupId: sourceGroupId } : null
}

/** Moves a pane of this window's tab for another client; a pane the window cannot reach is refused. */
export async function moveTerminalPaneToNewTabForClient(
  request: TerminalPaneMoveToNewTabTarget & { worktreeId: string; sourceTabId: string }
): Promise<TerminalLeafMoveResult> {
  const { worktreeId, sourceTabId, ...move } = request
  try {
    const handler = await mountedHandler(worktreeId, sourceTabId)
    const moved = handler ? await handler(move) : null
    if (moved) {
      return { status: 'moved', ptyId: moved.ptyId }
    }
  } catch (error) {
    console.warn('[terminal-pane-detach] could not move the pane for a client', error)
  }
  return { status: 'refused', reason: 'pane_unavailable' }
}
