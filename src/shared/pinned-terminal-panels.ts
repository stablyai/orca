import type { PinnedTerminalPanel } from './types'

// Why: each panel owns a live PTY; a bound keeps a corrupted profile from
// spawning an unbounded number of shells at startup.
export const MAX_PINNED_TERMINAL_PANELS = 8

const MAX_PANEL_TITLE_LENGTH = 60
// Why: panel commands are one observability invocation (nvtop, btop, watch …),
// not scripts; the cap keeps hand-edited profiles from smuggling megabyte
// payloads into every settings broadcast.
const MAX_PANEL_COMMAND_LENGTH = 500

/** Tab host for panel terminals — a sentinel workspace like the floating
 *  workspace, so panel tabs never attach to a real repo worktree. */
export const PINNED_TERMINAL_PANELS_WORKTREE_ID = 'global-pinned-terminal-panels'

function normalizePinnedTerminalPanelCommand(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  // Why: control characters can't be typed into the settings field; their
  // presence means a corrupted or crafted profile, so drop the entry rather
  // than deliver escape sequences to a shell.
  if (
    trimmed.length === 0 ||
    trimmed.length > MAX_PANEL_COMMAND_LENGTH ||
    // eslint-disable-next-line no-control-regex -- intentional unicode range
    /[\u0000-\u001f\u007f]/.test(trimmed)
  ) {
    return null
  }
  return trimmed
}

/** Drops malformed entries instead of failing the whole settings write, so one
 *  bad panel (hand-edited profile, older build) can't wedge the rest. */
export function normalizePinnedTerminalPanels(value: unknown): PinnedTerminalPanel[] {
  if (!Array.isArray(value)) {
    return []
  }
  const seenIds = new Set<string>()
  const panels: PinnedTerminalPanel[] = []
  for (const entry of value) {
    if (panels.length >= MAX_PINNED_TERMINAL_PANELS) {
      break
    }
    if (typeof entry !== 'object' || entry === null) {
      continue
    }
    const { id, title, command } = entry as Record<string, unknown>
    const normalizedCommand = normalizePinnedTerminalPanelCommand(command)
    if (
      typeof id !== 'string' ||
      id.length === 0 ||
      seenIds.has(id) ||
      normalizedCommand === null
    ) {
      continue
    }
    const trimmedTitle =
      typeof title === 'string' ? title.trim().slice(0, MAX_PANEL_TITLE_LENGTH) : ''
    seenIds.add(id)
    panels.push({
      id,
      // Why: an empty title renders an unclickable-looking blank row; fall
      // back to the command so the entry stays identifiable.
      title:
        trimmedTitle.length > 0 ? trimmedTitle : normalizedCommand.slice(0, MAX_PANEL_TITLE_LENGTH),
      command: normalizedCommand
    })
  }
  return panels
}
