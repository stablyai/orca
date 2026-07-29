import type {
  TerminalLayoutSnapshot,
  TerminalPaneLayoutNode,
  TerminalPaneSplitDirection
} from '../../../../shared/types'
import { isTerminalLeafId } from '../../../../shared/stable-pane-id'
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

export const EMPTY_LAYOUT: TerminalLayoutSnapshot = {
  root: null,
  activeLeafId: null,
  expandedLeafId: null
}

// Why: SerializeAddon replays mode bits assuming reattach to a live TUI, but Orca restores against a fresh shell with none, so stale bits (e.g. focus reporting rings the bell on click) must be reset.
export const RESET_TERMINAL_CURSOR_STYLE = '\x1b[0 q'
export const RESET_KITTY_KEYBOARD_PROTOCOL = '\x1b[<99u\x1b[=0u'
// Every mouse mode the daemon can re-arm from a snapshot: protocols 9/1000/1002/1003 + SGR encodings 1006/1016.
export const RESET_MOUSE_REPORTING =
  '\x1b[?9l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1016l'

export const POST_REPLAY_MODE_RESET = `${RESET_TERMINAL_CURSOR_STYLE}${RESET_KITTY_KEYBOARD_PROTOCOL}\x1b[?25h${RESET_MOUSE_REPORTING}\x1b[?1004l\x1b[?2004l`

// Why: same-session live replay; keep cursor/focus cleanup but preserve Kitty flags the running TUI relies on.
export const POST_REPLAY_LIVE_SNAPSHOT_RESET = `${RESET_TERMINAL_CURSOR_STYLE}\x1b[?25h\x1b[?1004l`

// Why: daemon reattach hits a live session, so skip the full reset; still clear cursor/focus/mouse/Kitty bits harmful to a plain shell after a bad TUI exit — safe for live TUIs since the post-reattach SIGWINCH repaints the cursor.
export const POST_REPLAY_REATTACH_RESET = `${RESET_TERMINAL_CURSOR_STYLE}${RESET_KITTY_KEYBOARD_PROTOCOL}\x1b[?25h${RESET_MOUSE_REPORTING}\x1b[?1004l`

// Why: a live agent owns focus reporting; resetting ?1004h suppresses the focus-in it needs to re-anchor its cursor (IME).
export const POST_REPLAY_LIVE_AGENT_REATTACH_RESET = `${RESET_TERMINAL_CURSOR_STYLE}${RESET_KITTY_KEYBOARD_PROTOCOL}\x1b[?25h`

// Why: DECTCEM applies in emission order, so the payload's last ?25l/?25h is the cursor state the TUI left.
export function replayPayloadEndsWithCursorHidden(payload: string): boolean {
  const hideIndex = payload.lastIndexOf('\x1b[?25l')
  return hideIndex !== -1 && hideIndex > payload.lastIndexOf('\x1b[?25h')
}

// Why: some agents hide the real cursor and draw their own, so preserve the payload's final visibility (pty-connection re-shows it if the agent was actually a dead TUI).
export function buildPostReplayLiveAgentReattachReset(payload: string): string {
  return replayPayloadEndsWithCursorHidden(payload)
    ? `${RESET_TERMINAL_CURSOR_STYLE}${RESET_KITTY_KEYBOARD_PROTOCOL}`
    : POST_REPLAY_LIVE_AGENT_REATTACH_RESET
}

// Why: a live agent owns cursor/focus here; forcing ?25h/?1004l breaks a parked agent that only arms ?1004h at startup.
export const POST_REPLAY_LIVE_AGENT_SNAPSHOT_RESET = RESET_TERMINAL_CURSOR_STYLE

// Cross-platform monospace chain: browsers skip fonts absent on the current OS, so listing all is safe.
// Nerd Fonts come last to cover PUA glyphs (U+E000–U+F8FF) from OMP/Powerline that standard monospace fonts lack.
const FALLBACK_FONTS = [
  'SF Mono', // macOS 10.12+
  'Menlo', // macOS (older)
  'Monaco', // macOS (legacy)
  'Cascadia Mono', // Windows 11+
  'Consolas', // Windows Vista+
  'DejaVu Sans Mono', // Linux (common)
  'Liberation Mono', // Linux (common)
  'Orca Nerd Font Symbols', // bundled PUA fallback for OMP/Powerline glyphs
  'Symbols Nerd Font Mono', // purpose-built Nerd Fonts symbols-only fallback
  'MesloLGS Nerd Font', // p10k's recommended font; very common on zsh setups
  'JetBrainsMono Nerd Font', // widely installed; Ghostty ships a JBM-derived font
  'Hack Nerd Font', // common Nerd Font among Linux developers
  'monospace' // ultimate generic fallback
] as const

export function buildFontFamily(fontFamily: string): string {
  const trimmed = fontFamily.trim()
  const parts = trimmed ? [`"${trimmed}"`] : []
  const lowerParts = parts.map((p) => p.toLowerCase())
  // Append each fallback unless already present (case-insensitive) to avoid duplicates.
  for (const fallback of FALLBACK_FONTS) {
    const lower = fallback.toLowerCase()
    if (!lowerParts.some((p) => p.includes(lower))) {
      // Generic keywords like "monospace" are unquoted; named fonts are quoted.
      parts.push(fallback === 'monospace' ? fallback : `"${fallback}"`)
    }
  }
  return parts.join(', ')
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
        replayIntoTerminal(pane, replayingPanesRef, buf, renderOptions)
        // Newline first so the new shell prompt doesn't trigger zsh's PROMPT_EOL_MARK (%) indicator.
        replayIntoTerminal(pane, replayingPanesRef, '\r\n', renderOptions)
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

  const inputSnapshot = snapshot
  const normalized = normalizeTerminalLayoutSnapshot(snapshot)
  snapshot = normalized.snapshot
  const initialLeafId = snapshot.root
    ? getLeftmostLeafId(snapshot.root)
    : (resolveRootlessTerminalLayoutLeafId(inputSnapshot ?? snapshot) ?? undefined)
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
