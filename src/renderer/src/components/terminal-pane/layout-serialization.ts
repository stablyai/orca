import type {
  TerminalLayoutSnapshot,
  TerminalPaneLayoutNode,
  TerminalPaneSplitDirection
} from '../../../../shared/types'
import { isTerminalLeafId } from '../../../../shared/stable-pane-id'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { replayIntoTerminal, type ReplayingPanesRef } from './replay-guard'
import type { RestoredViewportBlankingPanesRef } from './terminal-restored-viewport'
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

// Why: xterm's SerializeAddon captures display state by emitting mode-setting
// bytes (e.g. `\e[?1004h` for focus reporting) so a re-fed emulator lands in
// the same mode as the snapshot source. That's correct for tmux-style
// "attach to a still-running TUI" — but Orca restores scrollback against a
// *fresh* shell, with no TUI to consume those modes. A stale focus-reporting
// bit causes xterm to emit `\e[I`/`\e[O` on every pane click, which the
// fresh zsh treats as unbound key input and rings the bell for.
//
// Reset the interactive modes most commonly left set by crashed/ended TUIs
// so replayed mode bits do not leak into the fresh shell. ghostty achieves
// the same end by not restoring state at all.
//
//   0 SP q              — DECSCUSR cursor style/blink reset (raw replay can
//                         carry a stale steady cursor override; reset to the
//                         user's configured xterm cursor)
//   25                  — DECTCEM cursor visibility (SerializeAddon captures
//                         `?25l` when the cursor was hidden at snapshot time;
//                         without an explicit `?25h` here the cursor stays
//                         invisible in the restored terminal)
//   1000/1002/1003/1006 — mouse reporting variants
//   1004                — focus event reporting (the actual bug source)
//   2004                — bracketed paste
//   <99u/=0u            — Kitty keyboard flags pushed by TUIs such as Codex
export const RESET_TERMINAL_CURSOR_STYLE = '\x1b[0 q'
export const RESET_KITTY_KEYBOARD_PROTOCOL = '\x1b[<99u\x1b[=0u'

export const POST_REPLAY_MODE_RESET = `${RESET_TERMINAL_CURSOR_STYLE}${RESET_KITTY_KEYBOARD_PROTOCOL}\x1b[?25h\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1004l\x1b[?1006l\x1b[?2004l`

// Why: hidden-output recovery replays a snapshot of the same live renderer
// session. Keep cursor/focus cleanup, but preserve Kitty keyboard flags that
// the still-running foreground TUI may rely on.
export const POST_REPLAY_LIVE_SNAPSHOT_RESET = `${RESET_TERMINAL_CURSOR_STYLE}\x1b[?25h\x1b[?1004l`

// Why: daemon snapshot restore reattaches to a live session, so we avoid the
// full POST_REPLAY_MODE_RESET bundle there. The default still clears the two
// stale mode bits most harmful to a plain shell after a TUI exits badly:
//
//   0 q  — DECSCUSR cursor style/blink reset: raw replay can contain a stale
//          steady cursor override, while SerializeAddon does not preserve an
//          authoritative current cursor style. Reset to the user's configured
//          xterm cursor; the post-reattach SIGWINCH lets live TUIs repaint if
//          they need a different cursor.
//   25   — DECTCEM cursor visibility: snapshots can preserve hidden cursor
//          state from a no-longer-running TUI; reset by default so shells do
//          not inherit a permanently invisible cursor.
//   1004 — focus event reporting: snapshots can preserve focus reporting from
//          a no-longer-running TUI; reset by default so shells do not receive
//          stray focus-in/focus-out bytes.
//   <99u/=0u — Kitty keyboard mode is renderer-side xterm state; stale copies
//              can make the next Ctrl+C encode as CSI-u after reattach.
export const POST_REPLAY_REATTACH_RESET = `${RESET_TERMINAL_CURSOR_STYLE}${RESET_KITTY_KEYBOARD_PROTOCOL}\x1b[?25h\x1b[?1004l`

// Why: a live agent TUI legitimately owns focus reporting; resetting `?1004h`
// would suppress the post-reattach focus-in the agent needs to move its real
// cursor back to the input caret (the IME anchor). Cursor visibility is still
// reset: agent detection can false-positive on a dead TUI's leftovers, and a
// permanently invisible shell cursor is far worse than the brief flash a live
// agent re-hides on its post-reattach SIGWINCH repaint.
export const POST_REPLAY_LIVE_AGENT_REATTACH_RESET = `${RESET_TERMINAL_CURSOR_STYLE}${RESET_KITTY_KEYBOARD_PROTOCOL}\x1b[?25h`

// Cross-platform monospace fallback chain ensures the terminal always has a
// usable font regardless of OS.  macOS-only fonts like SF Mono and Menlo are
// harmless on other platforms (the browser skips them), while Cascadia Mono /
// Consolas cover Windows and DejaVu Sans Mono / Liberation Mono cover Linux.
//
// Why Nerd Fonts are listed after the regular monospace fonts: OMP, Powerline
// prompts, and many shell plugins emit glyphs in the Unicode Private Use Area
// (U+E000–U+F8FF) that no standard monospace font contains. The bundled symbol
// font gives Orca a known-good fallback even on clean systems, while the
// installed-font fallbacks keep users' existing terminal setups working.
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
  // Append each fallback unless the user's font name already contains it
  // (case-insensitive) to avoid duplicates like '"SF Mono", "SF Mono"'.
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
  // We read the computed flex-grow values to derive the first-child proportion.
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
 * Write saved scrollback buffers into the restored panes so the user sees
 * their previous terminal output after an app restart.  If a buffer was
 * captured while the alternate screen was active (e.g. an agent TUI was
 * running at shutdown), we exit alt-screen first so the user sees a usable
 * normal-mode terminal.
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
    try {
      let buf = buffer
      // If buffer ends in alt-screen mode (agent TUI was running at
      // shutdown), exit alt-screen so the user sees a usable terminal.
      const lastOn = buf.lastIndexOf(ALT_SCREEN_ON)
      const lastOff = buf.lastIndexOf(ALT_SCREEN_OFF)
      if (lastOn > lastOff) {
        buf = buf.slice(0, lastOn)
      }
      if (buf.length > 0) {
        // Why replayIntoTerminal: the serialized buffer can contain query
        // sequences from the prior session (DA1, DECRQM, OSC 10/11, focus,
        // CPR). Writing those through xterm.write would trigger auto-replies
        // that land in the new shell's stdin. See replay-guard.ts.
        replayIntoTerminal(pane, replayingPanesRef, buf)
        // Ensure cursor is on a new line so the new shell prompt
        // doesn't trigger zsh's PROMPT_EOL_MARK (%) indicator.
        replayIntoTerminal(pane, replayingPanesRef, '\r\n')
        // Clear any mode bits the serialized buffer replayed into xterm.
        // The shell underneath is fresh and has no TUI consuming these modes.
        // See POST_REPLAY_MODE_RESET comment.
        replayIntoTerminal(pane, replayingPanesRef, POST_REPLAY_MODE_RESET)
        // Why: connection resolution happens after layout replay; only the
        // fresh-shell paths should move these visible rows into scrollback.
        restoredViewportBlankingPanesRef?.current.add(pane.id)
      }
    } catch {
      // If restore fails, continue with blank terminal.
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
