import type { TerminalLayoutSnapshot } from '../../../../shared/types'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager'
import type { PtyTransport } from './pty-transport'
import { flushTerminalOutput } from '@/lib/pane-manager/pane-terminal-output-scheduler'
import { paneLeafId, serializeTerminalLayout } from './layout-serialization'
import { mergeCapturedLeafState } from './merge-captured-leaf-state'

const MAX_BUFFER_BYTES = 512 * 1024

type ShutdownPane = Pick<ManagedPane, 'id' | 'terminal' | 'serializeAddon'>

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
}

export function captureTerminalShutdownLayout({
  manager,
  container,
  expandedPaneId,
  paneTransports,
  paneTitlesByPaneId,
  existingLayout,
  captureBuffers = true
}: CaptureTerminalShutdownLayoutArgs): TerminalLayoutSnapshot {
  const panes = manager.getPanes()
  const buffers: Record<string, string> = {}

  if (captureBuffers) {
    for (const pane of panes) {
      try {
        // Why: non-focused panes may have renderer-throttled PTY bytes queued;
        // push them into xterm before taking the shutdown scrollback snapshot.
        flushTerminalOutput(pane.terminal)
        const leafId = paneLeafId(pane.id)
        let scrollback = pane.terminal.options.scrollback ?? 10_000
        let serialized = pane.serializeAddon.serialize({ scrollback })
        // Cap at 512KB — binary search for largest scrollback that fits.
        if (serialized.length > MAX_BUFFER_BYTES && scrollback > 1) {
          let lo = 1
          let hi = scrollback
          let best = ''
          while (lo <= hi) {
            const mid = Math.floor((lo + hi) / 2)
            const attempt = pane.serializeAddon.serialize({ scrollback: mid })
            if (attempt.length <= MAX_BUFFER_BYTES) {
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
  const layout = serializeTerminalLayout(container, activePaneId, expandedPaneId)
  const currentLeafIds = new Set(panes.map((p) => paneLeafId(p.id)))
  const ptyEntries = panes
    .map((pane) => [paneLeafId(pane.id), paneTransports.get(pane.id)?.getPtyId() ?? null] as const)
    .filter((entry): entry is readonly [string, string] => entry[1] !== null)

  const mergedBuffers = captureBuffers
    ? mergeCapturedLeafState({
        prior: existingLayout?.buffersByLeafId,
        fresh: buffers,
        currentLeafIds
      })
    : {}
  const mergedPtyIds = mergeCapturedLeafState({
    prior: existingLayout?.ptyIdsByLeafId,
    fresh: Object.fromEntries(ptyEntries),
    currentLeafIds
  })
  if (Object.keys(mergedBuffers).length > 0) {
    layout.buffersByLeafId = mergedBuffers
  }
  if (Object.keys(mergedPtyIds).length > 0) {
    layout.ptyIdsByLeafId = mergedPtyIds
  }

  const titleEntries = panes
    .filter((p) => paneTitlesByPaneId[p.id])
    .map((p) => [paneLeafId(p.id), paneTitlesByPaneId[p.id]] as const)
  if (titleEntries.length > 0) {
    layout.titlesByLeafId = Object.fromEntries(titleEntries)
  }

  return layout
}
