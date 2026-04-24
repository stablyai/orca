import type {
  TerminalLayoutSnapshot,
  TerminalPaneLayoutNode,
  TerminalPaneSplitDirection
} from '../../../../shared/types'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { replayIntoTerminal, type ReplayingPanesRef } from './replay-guard'

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
//   1000/1002/1003/1006 — mouse reporting variants
//   1004                — focus event reporting (the actual bug source)
//   2004                — bracketed paste
export const POST_REPLAY_MODE_RESET =
  '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1004l\x1b[?1006l\x1b[?2004l'

// Why: daemon snapshot restore reattaches to a live session, so we avoid the
// full POST_REPLAY_MODE_RESET bundle there — a still-running TUI may still
// rely on mouse or bracketed-paste modes. Focus reporting is the exception:
// if xterm preserves `?1004h` across snapshot replay, pane focus/blur emits
// `\e[I` / `\e[O` into the PTY and shells like zsh ring BEL when no TUI is
// actively consuming them. Clearing only 1004 preserves the other live-session
// modes while preventing phantom bells on restored background tabs.
export const POST_REPLAY_FOCUS_REPORTING_RESET = '\x1b[?1004l'

export function paneLeafId(paneId: number): string {
  return `pane:${paneId}`
}

export function collectLeafIdsInOrder(node: TerminalPaneLayoutNode | null | undefined): string[] {
  if (!node) {
    return []
  }
  if (node.type === 'leaf') {
    return [node.leafId]
  }
  return [...collectLeafIdsInOrder(node.first), ...collectLeafIdsInOrder(node.second)]
}

function getLeftmostLeafId(node: TerminalPaneLayoutNode): string {
  return node.type === 'leaf' ? node.leafId : getLeftmostLeafId(node.first)
}

function collectReplayCreatedPaneLeafIds(
  node: Extract<TerminalPaneLayoutNode, { type: 'split' }>,
  leafIdsInReplayCreationOrder: string[]
): void {
  // Why: replayTerminalLayout() creates one new pane per split and assigns it
  // to the split's second subtree before recursing, so the new pane maps to
  // the leftmost leaf reachable within that second subtree.
  leafIdsInReplayCreationOrder.push(getLeftmostLeafId(node.second))

  if (node.first.type === 'split') {
    collectReplayCreatedPaneLeafIds(node.first, leafIdsInReplayCreationOrder)
  }
  if (node.second.type === 'split') {
    collectReplayCreatedPaneLeafIds(node.second, leafIdsInReplayCreationOrder)
  }
}

export function collectLeafIdsInReplayCreationOrder(
  node: TerminalPaneLayoutNode | null | undefined
): string[] {
  if (!node) {
    return []
  }
  const leafIdsInReplayCreationOrder = [getLeftmostLeafId(node)]
  if (node.type === 'split') {
    collectReplayCreatedPaneLeafIds(node, leafIdsInReplayCreationOrder)
  }
  return leafIdsInReplayCreationOrder
}

// Cross-platform monospace fallback chain ensures the terminal always has a
// usable font regardless of OS.  macOS-only fonts like SF Mono and Menlo are
// harmless on other platforms (the browser skips them), while Cascadia Mono /
// Consolas cover Windows and DejaVu Sans Mono / Liberation Mono cover Linux.
//
// Why Nerd Fonts are listed just before `monospace`: Powerline prompts (p10k,
// starship, oh-my-zsh) and many shell plugins emit glyphs in the Unicode
// Private Use Area (U+E000–U+F8FF) that no standard monospace font contains.
// When the user's primary font (e.g. SF Mono) is missing those code points
// the browser walks the fallback chain character-by-character, so adding
// commonly-installed Nerd Fonts here lets PUA glyphs render correctly without
// forcing the user to override their terminal font. Placed AFTER the regular
// system fonts so ASCII text still renders in the user's chosen font rather
// than being substituted by a Nerd Font variant.
const FALLBACK_FONTS = [
  'SF Mono', // macOS 10.12+
  'Menlo', // macOS (older)
  'Monaco', // macOS (legacy)
  'Cascadia Mono', // Windows 11+
  'Consolas', // Windows Vista+
  'DejaVu Sans Mono', // Linux (common)
  'Liberation Mono', // Linux (common)
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
    const paneId = Number(node.dataset.paneId ?? '')
    if (!Number.isFinite(paneId)) {
      return null
    }
    return { type: 'leaf', leafId: paneLeafId(paneId) }
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
    const firstGrow = parseFloat(first.style.flex) || 1
    const secondGrow = parseFloat(second.style.flex) || 1
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
  expandedPaneId: number | null
): TerminalLayoutSnapshot {
  const rootNode = serializePaneTree(
    root?.firstElementChild instanceof HTMLElement ? root.firstElementChild : null
  )
  return {
    root: rootNode,
    activeLeafId: activePaneId === null ? null : paneLeafId(activePaneId),
    expandedLeafId: expandedPaneId === null ? null : paneLeafId(expandedPaneId)
  }
}

function collectLeafIds(
  node: TerminalPaneLayoutNode,
  paneByLeafId: Map<string, number>,
  paneId: number
): void {
  if (node.type === 'leaf') {
    paneByLeafId.set(node.leafId, paneId)
    return
  }
  collectLeafIds(node.first, paneByLeafId, paneId)
  collectLeafIds(node.second, paneByLeafId, paneId)
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
  replayingPanesRef: ReplayingPanesRef
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
        // sequences that leaked in via the pendingWritesRef flush before
        // serialization (see TerminalPane capture hook). Writing those
        // through xterm would trigger auto-replies that land in the new
        // shell's stdin. See replay-guard.ts.
        replayIntoTerminal(pane, replayingPanesRef, buf)
        // Ensure cursor is on a new line so the new shell prompt
        // doesn't trigger zsh's PROMPT_EOL_MARK (%) indicator.
        replayIntoTerminal(pane, replayingPanesRef, '\r\n')
        // Clear any mode bits the serialized buffer replayed into xterm.
        // The shell underneath is fresh and has no TUI consuming these modes.
        // See POST_REPLAY_MODE_RESET comment.
        replayIntoTerminal(pane, replayingPanesRef, POST_REPLAY_MODE_RESET)
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

  const initialPane = manager.createInitialPane({ focus: focusInitialPane })
  if (!snapshot?.root) {
    paneByLeafId.set(paneLeafId(initialPane.id), initialPane.id)
    return paneByLeafId
  }

  const restoreNode = (node: TerminalPaneLayoutNode, paneId: number): void => {
    if (node.type === 'leaf') {
      paneByLeafId.set(node.leafId, paneId)
      return
    }

    const createdPane = manager.splitPane(paneId, node.direction as TerminalPaneSplitDirection, {
      ratio: node.ratio
    })
    if (!createdPane) {
      collectLeafIds(node, paneByLeafId, paneId)
      return
    }

    restoreNode(node.first, paneId)
    restoreNode(node.second, createdPane.id)
  }

  restoreNode(snapshot.root, initialPane.id)
  return paneByLeafId
}
