import type { AppState } from '../../types'
import type { RuntimeSessionTabChatView } from '../../../../../shared/runtime-session-contracts'
import type { TerminalLayoutSnapshot } from '../../../../../shared/terminal-tab-types'
import {
  resolveTerminalChatPairWrite,
  resolveTerminalTabViewMode,
  type TerminalTabViewMode
} from '../../../../../shared/terminal-tab-view-mode'
import { getCachedUnifiedTerminalTabForWorktree } from '@/components/terminal-pane/terminal-unified-tab-lookup'
import { locateTerminalTab } from '../../terminals/terminal-tab-location'
import { patchTab } from '../tab-group-state'
import { patchTerminalTabRow } from './tabs-host-mirroring'

type ChatPairState = Pick<
  AppState,
  'tabsByWorktree' | 'unifiedTabsByWorktree' | 'terminalLayoutsByTabId'
>
type ChatPairPatch = Partial<ChatPairState>

function findTerminalTabIndices(state: ChatPairState, terminalTabId: string) {
  const location = locateTerminalTab(state.tabsByWorktree, terminalTabId)
  const worktreeIds = location ? [location.worktreeId] : Object.keys(state.unifiedTabsByWorktree)
  for (const worktreeId of worktreeIds) {
    const unified = getCachedUnifiedTerminalTabForWorktree(
      state.unifiedTabsByWorktree,
      worktreeId,
      terminalTabId
    )
    // Why: a unified tab can briefly exist before its terminal row; it still holds the view.
    if (location || unified) {
      return { row: location?.tab ?? null, unified }
    }
  }
  return null
}

export function readTerminalChatViewMode(
  state: ChatPairState,
  terminalTabId: string
): TerminalTabViewMode | undefined {
  const indices = findTerminalTabIndices(state, terminalTabId)
  return indices ? resolveTerminalTabViewMode(indices.unified, indices.row) : undefined
}

export function readTerminalChatPair(
  state: ChatPairState,
  terminalTabId: string
): RuntimeSessionTabChatView | null {
  const indices = findTerminalTabIndices(state, terminalTabId)
  if (!indices) {
    return null
  }
  return {
    viewMode: resolveTerminalTabViewMode(indices.unified, indices.row) ?? null,
    chatLeafId: state.terminalLayoutsByTabId[terminalTabId]?.chatLeafId ?? null
  }
}

/** Writes `viewMode` to the unified tab and the row, the two indices desktop keeps it in. */
export function patchTerminalChatViewMode(
  state: ChatPairState,
  terminalTabId: string,
  viewMode: TerminalTabViewMode
): ChatPairPatch {
  const indices = findTerminalTabIndices(state, terminalTabId)
  if (!indices) {
    return {}
  }
  const unifiedPatch = indices.unified
    ? patchTab(state.unifiedTabsByWorktree, indices.unified.id, { viewMode })
    : null
  const rowPatch =
    !indices.row || indices.row.viewMode === viewMode
      ? {}
      : patchTerminalTabRow(state.tabsByWorktree, terminalTabId, { viewMode })
  return { ...unifiedPatch, ...rowPatch }
}

export function withTerminalChatOwner(
  layout: TerminalLayoutSnapshot,
  chatLeafId: string | undefined
): TerminalLayoutSnapshot {
  if (layout.chatLeafId === chatLeafId) {
    return layout
  }
  const { chatLeafId: _previousOwner, ...ownerless } = layout
  return chatLeafId ? { ...ownerless, chatLeafId } : ownerless
}

/**
 * The single patch for a chat pair write: unified `viewMode`, row `viewMode` and layout owner
 * change together. Null when the tab or the addressed leaf is unknown, or nothing changes.
 */
export function applyChatPairToState(
  state: ChatPairState,
  terminalTabId: string,
  request: { leafId: string | null; viewMode: TerminalTabViewMode }
): { patch: ChatPairPatch; from: TerminalTabViewMode; to: TerminalTabViewMode } | null {
  const indices = findTerminalTabIndices(state, terminalTabId)
  if (!indices) {
    return null
  }
  const layout = state.terminalLayoutsByTabId[terminalTabId]
  const currentViewMode = resolveTerminalTabViewMode(indices.unified, indices.row)
  const next = resolveTerminalChatPairWrite({
    current: {
      ...(currentViewMode ? { viewMode: currentViewMode } : {}),
      ...(layout?.chatLeafId ? { chatLeafId: layout.chatLeafId } : {})
    },
    root: layout?.root,
    viewMode: request.viewMode,
    leafId: request.leafId
  })
  if (!next?.viewMode) {
    return null
  }
  const nextLayout = layout ? withTerminalChatOwner(layout, next.chatLeafId) : undefined
  const patch: ChatPairPatch = {
    ...patchTerminalChatViewMode(state, terminalTabId, next.viewMode),
    ...(nextLayout && nextLayout !== layout
      ? { terminalLayoutsByTabId: { ...state.terminalLayoutsByTabId, [terminalTabId]: nextLayout } }
      : {})
  }
  if (Object.keys(patch).length === 0) {
    return null
  }
  return { patch, from: currentViewMode ?? 'terminal', to: next.viewMode }
}
