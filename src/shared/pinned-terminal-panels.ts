import type { PinnedTerminalPanel } from './types'
import type { SshTarget } from './ssh-types'
import { FLOATING_TERMINAL_WORKTREE_ID } from './constants'

// Why: each panel owns a live PTY, but PTYs spawn lazily on first visit, so
// the bound only guards against a corrupted profile flooding the sidebar.
// Sized for fleet setups: several hosts x a few observability views each.
export const MAX_PINNED_TERMINAL_PANELS = 24

const MAX_PANEL_TITLE_LENGTH = 60
// Why: panel commands are one observability invocation (nvtop, btop, watch …),
// not scripts; the cap keeps hand-edited profiles from smuggling megabyte
// payloads into every settings broadcast.
const MAX_PANEL_COMMAND_LENGTH = 500

// Why: hosts are SSH target ids typed into settings; anything longer is a
// corrupted profile, not a hostname.
const MAX_PANEL_HOST_LENGTH = 128

/** Tab host for panel terminals — a sentinel workspace like the floating
 *  workspace, so panel tabs never attach to a real repo worktree. */
export const PINNED_TERMINAL_PANELS_WORKTREE_ID = 'global-pinned-terminal-panels'

/** Reserved fold key for the rail's root "Nodes" disclosure that wraps every
 *  panel group. Lives in the same persisted collapsed-groups list; never a
 *  valid user group label (leading/trailing whitespace is trimmed away). */
export const PINNED_TERMINAL_PANELS_ROOT_FOLD = '\u0000nodes-root'

const PANEL_WORKTREE_ID_PREFIX = `${PINNED_TERMINAL_PANELS_WORKTREE_ID}::`

/** Per-panel tab host id. Panel identity rides the worktree id so host
 *  resolution (connection, execution host), which only ever sees a worktree
 *  id, can find the panel's configured SSH host. */
export function pinnedTerminalPanelWorktreeId(panelId: string): string {
  return `${PANEL_WORKTREE_ID_PREFIX}${panelId}`
}

export function getPinnedTerminalPanelIdFromWorktreeId(worktreeId: string): string | null {
  if (!worktreeId.startsWith(PANEL_WORKTREE_ID_PREFIX)) {
    return null
  }
  const panelId = worktreeId.slice(PANEL_WORKTREE_ID_PREFIX.length)
  return panelId.length > 0 ? panelId : null
}

export function isPinnedTerminalPanelWorktreeId(worktreeId: string): boolean {
  return (
    worktreeId === PINNED_TERMINAL_PANELS_WORKTREE_ID ||
    getPinnedTerminalPanelIdFromWorktreeId(worktreeId) !== null
  )
}

/** SSH target id for a panel tab-host worktree id, or null for local panels,
 *  unknown panels, and the legacy shared sentinel (always local). */
export function getPinnedTerminalPanelHostForWorktreeId(
  panels: readonly PinnedTerminalPanel[] | null | undefined,
  worktreeId: string
): string | null {
  const panelId = getPinnedTerminalPanelIdFromWorktreeId(worktreeId)
  if (panelId === null) {
    return null
  }
  return panels?.find((panel) => panel.id === panelId)?.host ?? null
}

/** Resolve a panel's user-facing host string to a configured SSH target id.
 *  Matches id, label, OpenSSH config alias, or hostname so operators can type
 *  the name they already use ("node-b"), not Orca's opaque target id. Returns
 *  null when nothing matches — callers must treat that as unresolved, never as
 *  local, so a typo can't silently run the command on the wrong machine. */
/** Renderer-side variant over the hydrated id->label map (the renderer never
 *  holds full SshTarget records). Matches target id or label; labels from an
 *  ssh-config import are the aliases operators type ("node-b"). */
export function resolvePinnedTerminalPanelSshTargetIdFromLabels(
  labels: ReadonlyMap<string, string> | null | undefined,
  panelHost: string
): string | null {
  if (!labels) {
    return null
  }
  if (labels.has(panelHost)) {
    return panelHost
  }
  for (const [id, label] of labels) {
    if (label === panelHost) {
      return id
    }
  }
  return null
}

export function resolvePinnedTerminalPanelSshTargetId(
  targets: readonly Pick<SshTarget, 'id' | 'label' | 'configHost' | 'host'>[] | null | undefined,
  panelHost: string
): string | null {
  const target = targets?.find(
    (candidate) =>
      candidate.id === panelHost ||
      candidate.label === panelHost ||
      candidate.configHost === panelHost ||
      candidate.host === panelHost
  )
  return target?.id ?? null
}

/** True for tab-host ids that are not real repo worktrees (floating workspace,
 *  pinned terminal panels) but still ride the normal terminal session pipeline. */
export function isSentinelWorktreeId(worktreeId: string): boolean {
  return worktreeId === FLOATING_TERMINAL_WORKTREE_ID || isPinnedTerminalPanelWorktreeId(worktreeId)
}

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
    const { id, title, command, host, group, enabled } = entry as Record<string, unknown>
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
    const trimmedGroup =
      typeof group === 'string' ? group.trim().slice(0, MAX_PANEL_TITLE_LENGTH) : ''
    const trimmedHost = typeof host === 'string' ? host.trim() : ''
    // Why: a present-but-malformed host drops the whole entry — silently
    // degrading to local would run the command on the wrong machine.
    if (
      trimmedHost.length > MAX_PANEL_HOST_LENGTH ||
      // eslint-disable-next-line no-control-regex -- intentional unicode range
      /[\u0000-\u001f\u007f\s]/.test(trimmedHost)
    ) {
      continue
    }
    const normalizedHost = trimmedHost.length > 0 ? trimmedHost : null
    seenIds.add(id)
    panels.push({
      id,
      // Why: an empty title renders an unclickable-looking blank row; fall
      // back to the command so the entry stays identifiable.
      title:
        trimmedTitle.length > 0 ? trimmedTitle : normalizedCommand.slice(0, MAX_PANEL_TITLE_LENGTH),
      command: normalizedCommand,
      ...(normalizedHost !== null ? { host: normalizedHost } : {}),
      ...(trimmedGroup.length > 0 ? { group: trimmedGroup } : {}),
      // Why: only an explicit false is persisted — enabled is the absent-field
      // default, so profiles stay minimal and older builds ignore the flag.
      ...(enabled === false ? { enabled: false } : {})
    })
  }
  return panels
}

/** The panels the sidebar should render: none when the master switch is off,
 *  otherwise every panel not individually disabled. Disabling never touches
 *  panel config or its parked PTY — re-enabling restores the entry as it was. */
export function visiblePinnedTerminalPanels(
  settings:
    | { pinnedTerminalPanels?: PinnedTerminalPanel[]; pinnedTerminalPanelsEnabled?: boolean }
    | null
    | undefined
): PinnedTerminalPanel[] {
  if (!settings || settings.pinnedTerminalPanelsEnabled === false) {
    return []
  }
  return (settings.pinnedTerminalPanels ?? []).filter((panel) => panel.enabled !== false)
}

/** Reorder for the settings list: move the dragged panel to the position of
 *  the panel it was dropped on. Returns the input array unchanged (same
 *  reference) when either id is unknown or the move is a no-op, so callers
 *  can skip the settings write. */
export function movePinnedTerminalPanel(
  panels: readonly PinnedTerminalPanel[],
  draggedId: string,
  overId: string
): readonly PinnedTerminalPanel[] {
  const from = panels.findIndex((panel) => panel.id === draggedId)
  const to = panels.findIndex((panel) => panel.id === overId)
  if (from < 0 || to < 0 || from === to) {
    return panels
  }
  const next = [...panels]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}
