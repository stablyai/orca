import type {
  TerminalLayoutSnapshot,
  TerminalPaneLayoutNode,
  TerminalPaneSplitDirection
} from '../../../../shared/terminal-tab-types'
import { isTerminalLeafId } from '../../../../shared/stable-pane-id'
import {
  POST_REPLAY_MODE_RESET,
  RESET_GRAPHIC_RENDITION
} from '../../../../shared/terminal-mode-reset-profiles'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { replayIntoTerminal, type ReplayingPanesRef } from './replay-guard'
import type { RestoredViewportBlankingPanesRef } from './terminal-restored-viewport'
import { isXtermInstanceDisposed } from '@/lib/pane-manager/xterm-instance-disposed'
import { recordRendererCrashBreadcrumb } from '@/lib/crash-breadcrumb-recorder'
import {
  getLeftmostLeafId,
  normalizeTerminalLayoutSnapshot,
  resolveRootlessTerminalLayoutLeafId
} from './terminal-layout-leaf-ids'

export {
  collectLeafIdsInOrder,
  collectLeafIdsInReplayCreationOrder,
  normalizeTerminalLayoutSnapshot
} from './terminal-layout-leaf-ids'

// Re-exported from lib so lib-layer pane defaults can share the one chain without
// importing back into components.
export { buildFontFamily } from '@/lib/terminal-font-family'

export const EMPTY_LAYOUT: TerminalLayoutSnapshot = {
  root: null,
  activeLeafId: null,
  expandedLeafId: null
}

export function getLayoutChildNodes(split: HTMLElement): HTMLElement[] {
  return Array.from(split.children).filter(
    (child): child is HTMLElement =>
      child instanceof HTMLElement &&
      (child.classList.contains('pane') || child.classList.contains('pane-split'))
  )
}

export function serializePaneTree(node: HTMLElement | null): TerminalPaneLayoutNode | null {
  if (!node) {
    return null
  }

  if (node.classList.contains('pane')) {
    const leafId = node.dataset.leafId
    if (!leafId || !isTerminalLeafId(leafId)) {
      return null
    }
    return { type: 'leaf', leafId }
  }

  if (!node.classList.contains('pane-split')) {
    return null
  }
  const [first, second] = getLayoutChildNodes(node)
  const firstNode = serializePaneTree(first ?? null)
  const secondNode = serializePaneTree(second ?? null)
  if (!firstNode || !secondNode) {
    return null
  }

  // Capture the flex ratio so resized panes survive serialization round-trips.
  let ratio: number | undefined
  if (first && second) {
    const firstGrow = Number.parseFloat(first.style.flex) || 1
    const secondGrow = Number.parseFloat(second.style.flex) || 1
    const total = firstGrow + secondGrow
    if (total > 0) {
      const r = firstGrow / total
      // Only store if meaningfully different from 0.5 (default equal split)
      if (Math.abs(r - 0.5) > 0.005) {
        ratio = Math.round(r * 1000) / 1000
      }
    }
  }

  return {
    type: 'split',
    direction: node.classList.contains('is-horizontal') ? 'horizontal' : 'vertical',
    first: firstNode,
    second: secondNode,
    ...(ratio !== undefined && { ratio })
  }
}

export function serializeTerminalLayout(
  root: HTMLDivElement | null,
  activePaneId: number | null,
  expandedPaneId: number | null,
  leafIdByPaneId?: ReadonlyMap<number, string>
): TerminalLayoutSnapshot {
  const rootNode = serializePaneTree(
    root?.firstElementChild instanceof HTMLElement ? root.firstElementChild : null
  )
  const activeLeafId = activePaneId === null ? null : leafIdByPaneId?.get(activePaneId)
  const expandedLeafId = expandedPaneId === null ? null : leafIdByPaneId?.get(expandedPaneId)
  return {
    root: rootNode,
    activeLeafId: activeLeafId && isTerminalLeafId(activeLeafId) ? activeLeafId : null,
    expandedLeafId: expandedLeafId && isTerminalLeafId(expandedLeafId) ? expandedLeafId : null
  }
}

/**
 * Write saved scrollback buffers into restored panes so the user sees prior
 * output after a restart. Exits alt-screen first if a buffer ended mid-TUI.
 */
export function restoreScrollbackBuffers(
  manager: PaneManager,
  savedBuffers: Record<string, string> | undefined,
  restoredPaneByLeafId: Map<string, number>,
  replayingPanesRef: ReplayingPanesRef,
  restoredViewportBlankingPanesRef?: RestoredViewportBlankingPanesRef
): void {
  if (!savedBuffers) {
    return
  }
  const ALT_SCREEN_ON = '\x1b[?1049h'
  const ALT_SCREEN_OFF = '\x1b[?1049l'
  for (const [oldLeafId, buffer] of Object.entries(savedBuffers)) {
    const newPaneId = restoredPaneByLeafId.get(oldLeafId)
    if (newPaneId == null || !buffer) {
      continue
    }
    const pane = manager.getPanes().find((p) => p.id === newPaneId)
    if (!pane) {
      continue
    }
    // Breadcrumb: writes into a disposed xterm are silent (no throw), the suspected source of startup zombie panes.
    if (isXtermInstanceDisposed(pane.terminal)) {
      recordRendererCrashBreadcrumb('terminal_restore_write_target_disposed', {
        paneId: pane.id
      })
      continue
    }
    try {
      const renderOptions = {
        shouldRefreshViewportSynchronously: () => !manager.hasWebglRenderer(pane.id)
      }
      let buf = buffer
      // If the buffer ends in alt-screen (agent TUI at shutdown), exit it so the terminal is usable.
      const lastOn = buf.lastIndexOf(ALT_SCREEN_ON)
      const lastOff = buf.lastIndexOf(ALT_SCREEN_OFF)
      if (lastOn > lastOff) {
        buf = buf.slice(0, lastOn)
      }
      if (buf.length > 0) {
        // replayIntoTerminal: buffer queries (DA1/DECRQM/CPR) would auto-reply into the new shell's stdin. See replay-guard.ts.
        replayIntoTerminal(
          pane,
          replayingPanesRef,
          `${RESET_GRAPHIC_RENDITION}${buf}${RESET_GRAPHIC_RENDITION}\r\n`,
          renderOptions
        )
        // The grounded newline avoids both the prompt marker and background-color erase from the captured pen.
        // Clear mode bits the buffer replayed: the fresh shell has no TUI to consume them. See POST_REPLAY_MODE_RESET.
        replayIntoTerminal(pane, replayingPanesRef, POST_REPLAY_MODE_RESET, renderOptions)
        // Why: connection resolution runs after layout replay; only fresh-shell paths move these rows into scrollback.
        restoredViewportBlankingPanesRef?.current.add(pane.id)
      }
    } catch (error: unknown) {
      // Breadcrumb: this catch was silent while zombie panes went undiagnosed.
      recordRendererCrashBreadcrumb('terminal_restore_write_failed', {
        paneId: pane.id,
        errorName: error instanceof Error ? error.name : typeof error,
        errorMessage: error instanceof Error ? error.message : String(error)
      })
    }
  }
}

export function replayTerminalLayout(
  manager: PaneManager,
  snapshot: TerminalLayoutSnapshot | null | undefined,
  focusInitialPane: boolean
): Map<string, number> {
  const paneByLeafId = new Map<string, number>()

  const normalized = normalizeTerminalLayoutSnapshot(snapshot)
  snapshot = normalized.snapshot
  const initialLeafId = snapshot.root
    ? getLeftmostLeafId(snapshot.root)
    : (resolveRootlessTerminalLayoutLeafId(snapshot) ?? undefined)
  const initialPane = manager.createInitialPane({ focus: focusInitialPane, leafId: initialLeafId })
  if (!snapshot?.root) {
    paneByLeafId.set(initialPane.leafId, initialPane.id)
    return paneByLeafId
  }

  const restoreNode = (node: TerminalPaneLayoutNode, paneId: number): void => {
    if (node.type === 'leaf') {
      paneByLeafId.set(node.leafId, paneId)
      return
    }

    const createdPane = manager.splitPane(paneId, node.direction as TerminalPaneSplitDirection, {
      ratio: node.ratio,
      leafId: getLeftmostLeafId(node.second)
    })
    if (!createdPane) {
      restoreNode(node.first, paneId)
      return
    }

    restoreNode(node.first, paneId)
    restoreNode(node.second, createdPane.id)
  }

  restoreNode(snapshot.root, initialPane.id)
  return paneByLeafId
}
