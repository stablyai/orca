import type { TerminalLayoutSnapshot } from '../../../../shared/types'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager'
import type { PtyTransport } from './pty-transport'
import { flushTerminalOutput } from '@/lib/pane-manager/pane-terminal-output-scheduler'
import { serializeTerminalLayout } from './layout-serialization'
import { mergeCapturedLeafState } from './merge-captured-leaf-state'
import { resolveTerminalLayoutActiveLeafId } from './terminal-layout-leaf-ids'
import { TERMINAL_SCROLLBACK_SESSION_BUFFER_BYTE_LIMIT } from '../../../../shared/terminal-scrollback-limits'
import { serializeWithAbsoluteCursor } from '../../../../shared/terminal-serialize-absolute-cursor'
import { measureUtf8ByteLength } from '../../../../shared/utf8-byte-limits'

const MAX_BUFFER_BYTES = TERMINAL_SCROLLBACK_SESSION_BUFFER_BYTE_LIMIT

type ShutdownPane = Pick<ManagedPane, 'id' | 'leafId' | 'terminal' | 'serializeAddon'>

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
  return !measureUtf8ByteLength(serialized, { stopAfterBytes: MAX_BUFFER_BYTES }).exceededLimit
}

export function captureTerminalShutdownLayout({
  manager,
  container,
  expandedPaneId,
  paneTransports,
  paneTitlesByPaneId,
  existingLayout,
  captureBuffers = true,
  clearedScrollbackLeafIds
}: CaptureTerminalShutdownLayoutArgs): TerminalLayoutSnapshot {
  const panes = manager.getPanes()
  const buffers: Record<string, string> = {}

  if (captureBuffers) {
    for (const pane of panes) {
      try {
        // Why: non-focused panes may have renderer-throttled PTY bytes queued;
        // push them into xterm before taking the shutdown scrollback snapshot.
        flushTerminalOutput(pane.terminal)
        const leafId = pane.leafId
        let scrollback = pane.terminal.options.scrollback ?? 10_000
        // Why serializeWithAbsoluteCursor: these buffers replay into fresh
        // xterms on session restore, and SerializeAddon's relative cursor
        // restore lands one column short after a wrap-pending final row.
        let serialized = serializeWithAbsoluteCursor(pane.serializeAddon, pane.terminal, {
          scrollback
        })
        // Why: SSH sleep keeps this string in session JSON; cap by UTF-8
        // bytes so non-ASCII scrollback cannot bypass the intended bound.
        if (!fitsSessionScrollbackByteLimit(serialized) && scrollback > 1) {
          let lo = 1
          let hi = scrollback
          let best = ''
          while (lo <= hi) {
            const mid = Math.floor((lo + hi) / 2)
            const attempt = serializeWithAbsoluteCursor(pane.serializeAddon, pane.terminal, {
              scrollback: mid
            })
            if (fitsSessionScrollbackByteLimit(attempt)) {
              best = attempt
              lo = mid + 1
            } else {
              hi = mid - 1
            }
          }
          serialized = best
        }
        if (serialized.length > 0) {
          buffers[leafId] = serialized
        }
      } catch {
        // Serialization failure for one pane should not block others.
      }
    }
  }

  const activePaneId = manager.getActivePane()?.id ?? panes[0]?.id ?? null
  const layout = serializeTerminalLayout(
    container,
    activePaneId,
    expandedPaneId,
    new Map(panes.map((pane) => [pane.id, pane.leafId]))
  )
  const currentLeafIds = new Set(panes.map((p) => p.leafId))
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
        fresh: buffers,
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
    .filter((p) => paneTitlesByPaneId[p.id])
    .map((p) => [p.leafId, paneTitlesByPaneId[p.id]] as const)
  if (titleEntries.length > 0) {
    layout.titlesByLeafId = Object.fromEntries(titleEntries)
  }

  return layout
}
