import type { TerminalLayoutSnapshot } from '../../../../shared/terminal-tab-types'
import type { PtyTransport } from './pty-transport'
import { flushTerminalOutput } from '@/lib/pane-manager/pane-terminal-output-scheduler'
import { serializeTerminalLayout } from './layout-serialization'
import { mergeCapturedLeafState } from './merge-captured-leaf-state'
import { resolveTerminalLayoutActiveLeafId } from './terminal-layout-leaf-ids'
import { TERMINAL_SCROLLBACK_SESSION_BUFFER_BYTE_LIMIT } from '../../../../shared/terminal-scrollback-limits'
import { serializeWithAbsoluteCursor } from '../../../../shared/terminal-serialize-absolute-cursor'
import { getUtf8ByteLength, isUtf8ByteLengthWithinLimit } from '../../../../shared/utf8-byte-limits'
import { yieldToEventLoop } from '../../../../shared/event-loop-yield'

const MAX_BUFFER_BYTES = TERMINAL_SCROLLBACK_SESSION_BUFFER_BYTE_LIMIT

type ShutdownPane = {
  id: number
  leafId: string
  terminal: {
    options?: { scrollback?: number }
    cols: number
    rows: number
    buffer: { active: { cursorX: number; cursorY: number } }
    write: (data: string, callback?: () => void) => void
  }
  serializeAddon: {
    serialize: (options?: { scrollback?: number }) => string
  }
}

type ShutdownPaneManager = {
  getPanes(): ShutdownPane[]
  getActivePane(): ShutdownPane | null
}

type CaptureTerminalShutdownLayoutArgs = {
  manager: ShutdownPaneManager
  container: HTMLDivElement
  expandedPaneId: number | null
  paneTransports: ReadonlyMap<number, Pick<PtyTransport, 'getPtyId'>>
  paneTitlesByPaneId: Record<number, string>
  existingLayout: TerminalLayoutSnapshot | undefined
  /** Re-read after a yielding serialize so a concurrent layout write is the merge `prior`. */
  readExistingLayout?: () => TerminalLayoutSnapshot | undefined
  captureBuffers?: boolean
  clearedScrollbackLeafIds?: ReadonlySet<string>
}

function omitClearedLeafState(
  record: Record<string, string> | undefined,
  clearedLeafIds: ReadonlySet<string> | undefined
): Record<string, string> | undefined {
  if (!record || !clearedLeafIds || clearedLeafIds.size === 0) {
    return record
  }
  const next = Object.fromEntries(
    Object.entries(record).filter(([leafId]) => !clearedLeafIds.has(leafId))
  )
  return Object.keys(next).length > 0 ? next : undefined
}

function fitsSessionScrollbackByteLimit(serialized: string): boolean {
  return isUtf8ByteLengthWithinLimit(serialized, MAX_BUFFER_BYTES)
}

// Why bounded: a plain row bisection costs ~13 full serializes per over-limit pane (~250ms at the
// 5k scrollback default, ~700ms at 50k), and force-park pays it synchronously per evicted pane.
const MAX_SCROLLBACK_FIT_PROBES = 4

/** Largest tail of `pane` that fits the session byte cap, found in a few interpolation probes. */
function serializeWithinSessionScrollbackByteLimit(
  pane: ShutdownPane,
  oversized: string,
  scrollback: number
): string {
  let overRows = scrollback
  let overBytes = getUtf8ByteLength(oversized)
  let fitRows = 0
  let fitBytes = 0
  let best: string | null = null
  // Why the extra probes before the first fit: returning '' would drop the whole pane, and those
  // probes shrink geometrically, so they cost less in total than a bisection's upper-half passes.
  for (let probe = 0; probe < MAX_SCROLLBACK_FIT_PROBES || best === null; probe += 1) {
    const anchorRows = best === null ? overRows : fitRows
    const anchorBytes = best === null ? overBytes : fitBytes
    // Bytes grow ~linearly with rows, so a secant step lands on the exact fit for uniform
    // scrollback; the midpoint floor stops it creeping when dense recent rows sit above sparse old ones.
    const estimate = Math.floor((anchorRows * MAX_BUFFER_BYTES) / Math.max(anchorBytes, 1))
    const midpoint = Math.floor((fitRows + overRows) / 2)
    const rows = Math.min(Math.max(Math.min(estimate, midpoint), fitRows + 1), overRows - 1)
    if (rows <= fitRows || rows >= overRows) {
      break
    }
    const attempt = serializeWithAbsoluteCursor(pane.serializeAddon, pane.terminal, {
      scrollback: rows
    })
    if (fitsSessionScrollbackByteLimit(attempt)) {
      best = attempt
      fitRows = rows
      fitBytes = getUtf8ByteLength(attempt)
    } else {
      overRows = rows
      overBytes = getUtf8ByteLength(attempt)
    }
  }
  return best ?? ''
}

function serializeShutdownPaneScrollback(pane: ShutdownPane): string | undefined {
  try {
    // Why: non-focused panes may have renderer-throttled PTY bytes queued;
    // push them into xterm before taking the shutdown scrollback snapshot.
    flushTerminalOutput(pane.terminal)
    let scrollback = pane.terminal.options?.scrollback ?? 10_000
    // Why serializeWithAbsoluteCursor: these buffers replay into fresh
    // xterms on session restore, and SerializeAddon's relative cursor
    // restore lands one column short after a wrap-pending final row.
    let serialized = serializeWithAbsoluteCursor(pane.serializeAddon, pane.terminal, {
      scrollback
    })
    // Why: SSH sleep keeps this string in session JSON; cap by UTF-8
    // bytes so non-ASCII scrollback cannot bypass the intended bound.
    if (!fitsSessionScrollbackByteLimit(serialized) && scrollback > 1) {
      serialized = serializeWithinSessionScrollbackByteLimit(pane, serialized, scrollback)
    }
    return serialized.length > 0 ? serialized : undefined
  } catch {
    // Serialization failure for one pane should not block others.
    return undefined
  }
}

function isShutdownPaneMounted(manager: ShutdownPaneManager, pane: ShutdownPane): boolean {
  try {
    return manager
      .getPanes()
      .some((candidate) => candidate.id === pane.id && candidate.terminal === pane.terminal)
  } catch {
    return false
  }
}

function captureMountedPaneBuffers(manager: ShutdownPaneManager): Record<string, string> {
  const buffers: Record<string, string> = {}
  for (const pane of manager.getPanes()) {
    const serialized = serializeShutdownPaneScrollback(pane)
    if (serialized !== undefined) {
      buffers[pane.leafId] = serialized
    }
  }
  return buffers
}

async function captureMountedPaneBuffersYielding(
  manager: ShutdownPaneManager
): Promise<Record<string, string>> {
  const buffers: Record<string, string> = {}
  const panes = manager.getPanes()
  for (let index = 0; index < panes.length; index += 1) {
    if (index > 0) {
      // Why: one remote pane's serialize+probe pass is tens to hundreds of ms;
      // yielding between panes keeps a 20-pane park off a single frame.
      await yieldToEventLoop()
    }
    const pane = panes[index]
    if (!isShutdownPaneMounted(manager, pane)) {
      continue
    }
    const serialized = serializeShutdownPaneScrollback(pane)
    if (serialized !== undefined) {
      buffers[pane.leafId] = serialized
    }
  }
  return buffers
}

function assembleTerminalShutdownLayout(
  args: CaptureTerminalShutdownLayoutArgs,
  buffers: Record<string, string>
): TerminalLayoutSnapshot {
  const {
    manager,
    container,
    expandedPaneId,
    paneTransports,
    paneTitlesByPaneId,
    existingLayout,
    captureBuffers = true,
    clearedScrollbackLeafIds
  } = args
  let panes: ShutdownPane[] = []
  let activePaneId: number | null = null
  try {
    panes = manager.getPanes()
    activePaneId = manager.getActivePane()?.id ?? panes[0]?.id ?? null
  } catch {
    panes = []
  }
  const layout = serializeTerminalLayout(
    container,
    activePaneId,
    expandedPaneId,
    new Map(panes.map((pane) => [pane.id, pane.leafId]))
  )
  // Why union captured leaves: a pane may unmount after its serialize; dropping
  // it here would throw away the only copy the yield loop just paid for.
  const currentLeafIds = new Set(panes.map((pane) => pane.leafId))
  for (const leafId of Object.keys(buffers)) {
    currentLeafIds.add(leafId)
  }
  const livePtyIdsByLeafId: Record<string, string> = {}
  const preservedPtyIdsByLeafId: Record<string, string> = {}
  for (const pane of panes) {
    const transport = paneTransports.get(pane.id)
    const livePtyId = transport?.getPtyId() ?? null
    if (livePtyId) {
      livePtyIdsByLeafId[pane.leafId] = livePtyId
      continue
    }
    const priorPtyId = existingLayout?.ptyIdsByLeafId?.[pane.leafId]
    if (transport && priorPtyId) {
      // Why: shutdown can capture during the post-remount attach gap where
      // each pane has a transport but the deferred PTY ID is still null.
      preservedPtyIdsByLeafId[pane.leafId] = priorPtyId
    }
  }

  const mergedBuffers = captureBuffers
    ? mergeCapturedLeafState({
        prior: omitClearedLeafState(existingLayout?.buffersByLeafId, clearedScrollbackLeafIds),
        fresh: omitClearedLeafState(buffers, clearedScrollbackLeafIds) ?? {},
        currentLeafIds
      })
    : {}
  const mergedScrollbackRefs = mergeCapturedLeafState({
    prior: omitClearedLeafState(existingLayout?.scrollbackRefsByLeafId, clearedScrollbackLeafIds),
    fresh: {},
    currentLeafIds
  })
  const ptyIdsByLeafId = { ...preservedPtyIdsByLeafId, ...livePtyIdsByLeafId }
  // Why: shutdown snapshots can otherwise persist focus on a mounted pane whose
  // transport was already cleared during PTY exit/reconnect cleanup. Unlike
  // scrollback, PTY bindings only preserve prior ids during a live attach gap.
  layout.activeLeafId = resolveTerminalLayoutActiveLeafId({
    root: layout.root,
    activeLeafId: layout.activeLeafId,
    ptyIdsByLeafId
  })
  if (Object.keys(mergedBuffers).length > 0) {
    layout.buffersByLeafId = mergedBuffers
  }
  if (Object.keys(mergedScrollbackRefs).length > 0) {
    layout.scrollbackRefsByLeafId = mergedScrollbackRefs
  }
  if (Object.keys(ptyIdsByLeafId).length > 0) {
    layout.ptyIdsByLeafId = ptyIdsByLeafId
  }

  const titleEntries = panes
    .filter((pane) => paneTitlesByPaneId[pane.id])
    .map((pane) => [pane.leafId, paneTitlesByPaneId[pane.id]] as const)
  if (titleEntries.length > 0) {
    layout.titlesByLeafId = Object.fromEntries(titleEntries)
  }

  return layout
}

export function captureTerminalShutdownLayout(
  args: CaptureTerminalShutdownLayoutArgs
): TerminalLayoutSnapshot {
  const buffers = args.captureBuffers === false ? {} : captureMountedPaneBuffers(args.manager)
  return assembleTerminalShutdownLayout(args, buffers)
}

/** Same snapshot as `captureTerminalShutdownLayout`, yielding between panes so a
 *  park cannot monopolize a frame. An unmounted pane is skipped; already-captured
 *  and still-mounted siblings are kept. */
export async function captureTerminalShutdownLayoutYielding(
  args: CaptureTerminalShutdownLayoutArgs
): Promise<TerminalLayoutSnapshot> {
  const buffers =
    args.captureBuffers === false ? {} : await captureMountedPaneBuffersYielding(args.manager)
  return assembleTerminalShutdownLayout(
    {
      ...args,
      existingLayout: args.readExistingLayout?.() ?? args.existingLayout
    },
    buffers
  )
}
