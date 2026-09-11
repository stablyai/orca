import type { Terminal } from '@xterm/xterm'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/terminal-tab-types'
import type { PtyTransport } from './pty-transport'
import type { PaneCwdMap } from './resolve-split-cwd'
import { writeTerminalOutput } from '@/lib/pane-manager/pane-terminal-output-scheduler'
import { RESET_KITTY_KEYBOARD_PROTOCOL } from '../../../../shared/terminal-mode-reset-profiles'
import type { TerminalPaneSplitSource } from '../../../../shared/feature-education-telemetry'
import type { HttpLinkSourceOwner } from '@/lib/http-link-routing'
import { resolveLocalhostHttpLinkDisplayUrl } from '@/lib/http-link-routing'
import { recordCreatedTerminalPaneSplit } from './terminal-pane-split-completion'
import { PRIMARY_SELECTION_MAX_LENGTH } from '@/lib/primary-selection'

/** Writes a transport-agnostic interrupt reset without running xterm work inline. */
export function resetTerminalKeyboardProtocolAfterInterrupt(terminal: Terminal): void {
  writeTerminalOutput(terminal, RESET_KITTY_KEYBOARD_PROTOCOL, {
    foreground: true,
    latencySensitive: false
  })
}

export function recordRuntimeCreatedTerminalPaneSplit(
  createdPane: unknown,
  args: {
    source: TerminalPaneSplitSource
    direction: 'vertical' | 'horizontal'
    telemetrySuppressed?: boolean
  }
): boolean {
  return recordCreatedTerminalPaneSplit(createdPane, args)
}

export type TerminalScrollbackPaneManager = {
  getPanes(): { terminal: Pick<Terminal, 'options'> }[]
}

export function applyTerminalScrollbackRowsToMountedPanes(
  manager: TerminalScrollbackPaneManager,
  rows: number
): void {
  for (const pane of manager.getPanes()) {
    if (pane.terminal.options.scrollback !== rows) {
      pane.terminal.options.scrollback = rows
    }
  }
}

export function extractUncHost(value: string | undefined): string | null {
  const match = /^(?:\\\\|\/\/)([^\\/]+)/.exec(value ?? '')
  return match?.[1] || null
}

export function reportActiveRendererPtyForPane(
  paneTransports: Map<number, PtyTransport>,
  activePaneId: number | null
): void {
  for (const [paneId, transport] of paneTransports) {
    const ptyId = transport.getPtyId()
    if (!ptyId || ptyId.startsWith('remote:')) {
      continue
    }
    window.api.pty.setActiveRendererPty?.(ptyId, activePaneId === paneId)
  }
}

export async function formatTerminalUrlTooltip(
  url: string,
  openLinkHint: string,
  sourceOwner: HttpLinkSourceOwner
): Promise<string | null> {
  const labeledUrl = await resolveLocalhostHttpLinkDisplayUrl(url, sourceOwner)
  if (!labeledUrl) {
    return null
  }
  try {
    const originalHost = new URL(url).host
    return `${labeledUrl} (${originalHost}; ${openLinkHint})`
  } catch {
    return `${labeledUrl} (${openLinkHint})`
  }
}

export function terminalSelectionExceedsPrimaryLimit(terminal: Terminal): boolean {
  const range = terminal.getSelectionPosition()
  if (!range) {
    return false
  }
  const startY = Math.min(range.start.y, range.end.y)
  const endY = Math.max(range.start.y, range.end.y)
  const rowSpan = endY - startY
  const cellEstimate =
    rowSpan === 0
      ? Math.abs(range.end.x - range.start.x)
      : rowSpan * terminal.cols + Math.abs(range.end.x - range.start.x)
  return cellEstimate > PRIMARY_SELECTION_MAX_LENGTH
}

export function hydrateTerminalScrollbackRefs(layout: TerminalLayoutSnapshot): {
  layout: TerminalLayoutSnapshot
  hydrated: boolean
} {
  const refs = layout.scrollbackRefsByLeafId
  if (!refs || Object.keys(refs).length === 0) {
    return { layout, hydrated: false }
  }

  const buffers = { ...layout.buffersByLeafId }
  let hydrated = false
  for (const [leafId, ref] of Object.entries(refs)) {
    if (buffers[leafId] !== undefined) {
      continue
    }
    try {
      const buffer = window.api.session.readTerminalScrollback({ ref })
      if (buffer) {
        buffers[leafId] = buffer
        hydrated = true
      }
    } catch {
      // Best-effort restore; failed snapshot reads should not block terminal mount.
    }
  }

  return hydrated
    ? { layout: { ...layout, buffersByLeafId: buffers }, hydrated }
    : { layout, hydrated }
}

export function resolveQueuedInitialCwd(
  queuedInitialCwd: string | null | undefined,
  consumeTabInitialCwd: () => string | null,
  defaultTabCwd: string
): { queuedInitialCwd: string | null; startupCwd: string } {
  const nextQueuedInitialCwd =
    queuedInitialCwd === undefined ? consumeTabInitialCwd() : queuedInitialCwd
  return {
    queuedInitialCwd: nextQueuedInitialCwd,
    startupCwd: nextQueuedInitialCwd ?? defaultTabCwd
  }
}

export function clearQueuedInitialCwdAfterFirstPane(
  queuedInitialCwd: string | null | undefined,
  defaultTabCwd: string,
  currentPtyCwd: string
): { queuedInitialCwd: string | null | undefined; ptyCwd: string } {
  if (!queuedInitialCwd) {
    return { queuedInitialCwd, ptyCwd: currentPtyCwd }
  }
  return { queuedInitialCwd: null, ptyCwd: defaultTabCwd }
}

export function resolvePaneLinkCwd(
  paneCwdMap: PaneCwdMap,
  paneId: number,
  fallbackCwd: string
): string {
  return paneCwdMap.get(paneId)?.cwd ?? fallbackCwd
}

export function resolvePaneSeedCwd(splitPaneCwd: string | undefined, fallbackCwd: string): string {
  return splitPaneCwd ?? fallbackCwd
}

export type SplitStartupPayload = { command: string; env?: Record<string, string> }

export function resolveTerminalHomePathFromEnv(
  env: Record<string, string> | undefined
): string | null {
  const home = env?.HOME?.trim()
  if (home) {
    return home
  }
  const userProfile = env?.USERPROFILE?.trim()
  if (userProfile) {
    return userProfile
  }
  const homeDrive = env?.HOMEDRIVE?.trim()
  const homePath = env?.HOMEPATH?.trim()
  return homeDrive && homePath ? `${homeDrive}${homePath}` : null
}

export function paneOwnsQueuedStartup(
  paneStartup: object | null | undefined,
  queuedStartup: object | null | undefined
): boolean {
  return queuedStartup != null && paneStartup === queuedStartup
}

export function createQueuedStartupConsumer(
  paneStartup: object | null | undefined,
  queuedStartup: object | null | undefined,
  consume: () => void,
  isStillQueued: () => boolean
): (() => void) | undefined {
  if (!paneOwnsQueuedStartup(paneStartup, queuedStartup)) {
    return undefined
  }
  let spent = false
  return () => {
    if (spent) {
      return
    }
    spent = true
    if (!isStillQueued()) {
      return
    }
    consume()
  }
}

export function splitPaneWithOneShotStartup<TPane>(
  deps: { startup?: SplitStartupPayload | null },
  startup: SplitStartupPayload,
  splitPane: () => TPane
): TPane {
  deps.startup = startup
  try {
    return splitPane()
  } finally {
    deps.startup = null
  }
}

export function replayLayoutWithOneShotParkIntent<TRestored>(
  deps: { mountFollowsTerminalPark: boolean },
  replayLayout: () => TRestored
): TRestored {
  try {
    return replayLayout()
  } finally {
    deps.mountFollowsTerminalPark = false
  }
}

export function shouldDetachPaneTransportOnUnmount(args: {
  tabStillExists: boolean
  tabId: string
  ptyId: string | null
  worktreeTabs: readonly TerminalTab[] | undefined
}): boolean {
  return Boolean(args.ptyId)
}

export type TerminalPaneVisibilitySnapshot = {
  tabId: string
  cwd: string | null | undefined
  isVisible: boolean
}

export function isTerminalPaneVisibilityResume(args: {
  previousIsVisible: boolean | null
  isVisible: boolean
}): boolean {
  return args.previousIsVisible === false && args.isVisible
}

export function getPreviousVisibleForTerminalPane(args: {
  previous: TerminalPaneVisibilitySnapshot | null
  tabId: string
  cwd: string | null | undefined
}): boolean | null {
  if (args.previous?.tabId !== args.tabId || args.previous.cwd !== args.cwd) {
    return null
  }
  return args.previous.isVisible
}

export function mapRestoredPaneTitlesByPaneId(
  savedTitles: Record<string, string> | undefined,
  restoredPaneByLeafId: ReadonlyMap<string, number>
): Record<number, string> {
  if (!savedTitles) {
    return {}
  }
  const restored: Record<number, string> = {}
  for (const [oldLeafId, title] of Object.entries(savedTitles)) {
    const newPaneId = restoredPaneByLeafId.get(oldLeafId)
    if (newPaneId != null && title) {
      restored[newPaneId] = title
    }
  }
  return restored
}
