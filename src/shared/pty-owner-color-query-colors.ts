import {
  terminalOscColorQueryReplies,
  type TerminalOscColorQueryReplyColors
} from './terminal-osc-color-reply'
import { resolveConfiguredTerminalColors } from './terminal-viewer-colors'
import { getTerminalThemeRepoId } from './repo-terminal-theme'

// Last resort before this process is told anything: Orca's default dark terminal theme.
export const ORCA_DEFAULT_COLOR_QUERY_REPLY_COLORS: TerminalOscColorQueryReplyColors =
  resolveConfiguredTerminalColors(
    {
      theme: 'dark',
      terminalThemeDark: '',
      terminalUseSeparateLightTheme: false,
      terminalThemeLight: ''
    },
    true
  )

function answersBothSlots(
  colors: TerminalOscColorQueryReplyColors | null | undefined
): colors is TerminalOscColorQueryReplyColors {
  return !!colors && terminalOscColorQueryReplies(colors, [10, 11]) !== null
}

/** Wire payloads are untrusted; only a pair that can answer both OSC 10 and 11 is kept. */
export function normalizeColorQueryReplyColors(
  value: unknown
): TerminalOscColorQueryReplyColors | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const foreground = 'foreground' in value ? value.foreground : undefined
  const background = 'background' in value ? value.background : undefined
  if (typeof foreground !== 'string' || typeof background !== 'string') {
    return null
  }
  const colors = { foreground, background }
  return answersBothSlots(colors) ? colors : null
}

export function colorQueryReplyColorsEqual(
  a: TerminalOscColorQueryReplyColors | null,
  b: TerminalOscColorQueryReplyColors | null
): boolean {
  return a?.foreground === b?.foreground && a?.background === b?.background
}

/** Project colours by repo id, as one PTY owner (this process, the daemon, one SSH relay) holds
 *  them: repo ids are unambiguous within one host. */
export type PtyOwnerRepoColors = Readonly<Record<string, TerminalOscColorQueryReplyColors>>

/** Project colours per execution host, as the app holds them for every owner it pushes to. */
export type PtyOwnerRepoColorsByHost = Readonly<Record<string, PtyOwnerRepoColors>>

/** Wire payloads are untrusted: unusable entries are dropped, and a non-object is null. */
export function normalizeRepoColorQueryReplyColors(value: unknown): PtyOwnerRepoColors | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const entries: [string, TerminalOscColorQueryReplyColors][] = []
  for (const [repoId, raw] of Object.entries(value)) {
    const colors = normalizeColorQueryReplyColors(raw)
    if (colors) {
      entries.push([repoId, colors])
    }
  }
  // Why fromEntries: it defines own keys, so a `__proto__` repo id cannot swap the prototype.
  return Object.fromEntries(entries)
}

export function repoColorQueryReplyColorsEqual(
  a: PtyOwnerRepoColors,
  b: PtyOwnerRepoColors
): boolean {
  const aKeys = Object.keys(a)
  return (
    aKeys.length === Object.keys(b).length &&
    aKeys.every(
      (repoId) => Object.hasOwn(b, repoId) && colorQueryReplyColorsEqual(a[repoId], b[repoId])
    )
  )
}

export function repoColorQueryReplyColorsByHostEqual(
  a: PtyOwnerRepoColorsByHost,
  b: PtyOwnerRepoColorsByHost
): boolean {
  const aKeys = Object.keys(a)
  return (
    aKeys.length === Object.keys(b).length &&
    aKeys.every(
      (hostId) => Object.hasOwn(b, hostId) && repoColorQueryReplyColorsEqual(a[hostId], b[hostId])
    )
  )
}

// Why process-wide: each process that owns PTYs (main, the daemon, a relay) serves one host,
// so all its panes answer from one viewer theme, pushed to it by the app that shows them.
let hostColors: TerminalOscColorQueryReplyColors | null = null
// Null until the app first says which projects are themed; an empty map is a known answer.
let repoColors: ReadonlyMap<string, TerminalOscColorQueryReplyColors> | null = null

/** A malformed push keeps the previous colours rather than blanking them. */
export function setPtyOwnerHostColors(value: unknown): void {
  hostColors = normalizeColorQueryReplyColors(value) ?? hostColors
}

/** One owner push: host-wide colours, plus project colours once the app knows them. */
export function setPtyOwnerColors(payload: { colors: unknown; byRepoId?: unknown }): void {
  setPtyOwnerHostColors(payload.colors)
  // Why absent keeps the map: main omits it until its renderer publishes project themes, so a
  // daemon that outlived the app keeps answering its sessions' project colours meanwhile.
  const byRepoId = normalizeRepoColorQueryReplyColors(payload.byRepoId)
  if (byRepoId) {
    repoColors = new Map(Object.entries(byRepoId))
  }
}

export function getPtyOwnerHostColors(): TerminalOscColorQueryReplyColors | null {
  return hostColors
}

/** Whether this owner has been told which projects are themed (even if none are). */
export function isPtyOwnerProjectMapKnown(): boolean {
  return repoColors !== null
}

/** The colours a PTY of this owner in this worktree answers with: its project's, else the host's. */
export function getPtyOwnerColorsForWorktree(
  worktreeId: string | null | undefined
): TerminalOscColorQueryReplyColors | null {
  const repoId = getTerminalThemeRepoId(worktreeId)
  return (repoId ? repoColors?.get(repoId) : undefined) ?? hostColors
}

export function _resetPtyOwnerHostColorsForTest(): void {
  hostColors = null
  repoColors = null
}

/**
 * The PTY owner always answers. This PTY's viewer colours (its project's theme, else the
 * host-wide one) win over the colours sent at spawn, so a theme change reaches old panes;
 * Orca's default theme answers when nothing has been reported yet.
 */
export function resolvePtyOwnerColorQueryColors(
  host: TerminalOscColorQueryReplyColors | null | undefined,
  spawn: TerminalOscColorQueryReplyColors | null | undefined
): TerminalOscColorQueryReplyColors {
  return [host, spawn].find(answersBothSlots) ?? ORCA_DEFAULT_COLOR_QUERY_REPLY_COLORS
}
