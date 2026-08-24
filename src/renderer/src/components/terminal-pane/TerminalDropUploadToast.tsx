import { useEffect, useState, useSyncExternalStore } from 'react'
import { ChevronDownIcon, FileIcon, UploadIcon, XIcon } from 'lucide-react'
import { Progress } from '@/components/ui/progress'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import {
  getRuntimeUploadSession,
  subscribeToRuntimeUploadSessions,
  summarizeRuntimeUploadSession,
  toggleRuntimeUploadCollapsed,
  type RuntimeUploadRow
} from '@/runtime/runtime-upload-session-state'
import { formatTransferredOfTotal, toPercent } from './terminal-drop-upload-progress'
import { formatTerminalDropUploadHeading } from './terminal-drop-upload-heading'

// Long enough to read the outcome, short enough not to linger over the terminal.
const SETTLED_HOLD_MS = 1200
const EXIT_ANIMATION_MS = 200

type Props = {
  sessionId: string
  onCancel: (uploadId: string) => void
  /** Closes the toast; the panel owns the timing so the exit is not cut short. */
  onDismiss: () => void
  /** Re-issues the toast: sonner re-measures height only on a new element identity. */
  onLayoutChange: () => void
}

export function TerminalDropUploadToast({
  sessionId,
  onCancel,
  onDismiss,
  onLayoutChange
}: Props): React.JSX.Element | null {
  const session = useSyncExternalStore(subscribeToRuntimeUploadSessions, () =>
    getRuntimeUploadSession(sessionId)
  )
  const [leaving, setLeaving] = useState(false)
  const settled = session?.settled === true

  useEffect(() => {
    if (!settled) {
      return
    }
    const reducedMotion =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const exitMs = reducedMotion ? 0 : EXIT_ANIMATION_MS
    const startExit = window.setTimeout(() => setLeaving(true), SETTLED_HOLD_MS)
    const close = window.setTimeout(onDismiss, SETTLED_HOLD_MS + exitMs)
    return () => {
      window.clearTimeout(startExit)
      window.clearTimeout(close)
    }
  }, [settled, onDismiss])

  // createElement at the call site still yields a valid element, so rendering
  // nothing here is safe once the session has ended.
  if (!session) {
    return null
  }
  const collapsed = session.collapsed
  const summary = summarizeRuntimeUploadSession(session)
  const heading = formatTerminalDropUploadHeading({
    rowCount: session.rows.length,
    settled: session.settled,
    doneCount: summary.doneCount,
    cancelledCount: summary.cancelledCount
  })

  return (
    <div
      className={cn(
        // Why: an unstyled toast is content-sized, so collapsing the list shrank the
        // panel horizontally too and it appeared to jump. Pinned to the Toaster's
        // own width so both states occupy the same box.
        'w-[var(--width,26rem)] overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-[0_10px_24px_rgba(0,0,0,0.18)]',
        leaving && 'animate-out fade-out-0 zoom-out-95 duration-200 fill-mode-forwards'
      )}
    >
      <div className="flex items-center gap-3 px-3 py-2.5">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-full border border-border">
          <UploadIcon className="size-3.5" aria-hidden />
        </span>
        <span className="min-w-0 flex-1 truncate text-sm">{heading}</span>
        {/* Fixed width so the row never reflows as the number gains digits. */}
        <span className="w-9 shrink-0 text-right text-sm tabular-nums text-muted-foreground">
          {session.settled ? '' : `${summary.percent}%`}
        </span>
        <button
          type="button"
          hidden={session.settled}
          onClick={() => {
            toggleRuntimeUploadCollapsed(sessionId)
            onLayoutChange()
          }}
          aria-expanded={!collapsed}
          aria-label={
            collapsed
              ? translate('auto.components.terminal.pane.terminal.drop.upload.expand', 'Show files')
              : translate(
                  'auto.components.terminal.pane.terminal.drop.upload.collapse',
                  'Hide files'
                )
          }
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {/* Why: one icon rotated, not two swapped — swapping replaces the node, so
              there is nothing to tween and the arrow flips in a single frame. */}
          <ChevronDownIcon
            className={cn(
              'size-4 transition-transform duration-200 ease-out motion-reduce:transition-none',
              !collapsed && 'rotate-180'
            )}
          />
        </button>
      </div>
      {!collapsed && (
        <ul className="border-t border-border">
          {session.rows.map((row) => (
            <UploadRowItem key={row.uploadId} row={row} onCancel={onCancel} />
          ))}
        </ul>
      )}
    </div>
  )
}

function UploadRowItem({
  row,
  onCancel
}: {
  row: RuntimeUploadRow
  onCancel: (uploadId: string) => void
}): React.JSX.Element {
  const percent = toPercent(row.sentBytes, row.totalBytes)
  const inactive = row.status !== 'uploading'

  return (
    <li className="flex items-center gap-3 px-3 py-2.5">
      <FileIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 overflow-hidden">
        <span className={cn('truncate text-[13px]', inactive && 'text-muted-foreground')}>
          {row.name}
        </span>
        <span className="truncate text-xs text-muted-foreground tabular-nums">
          {rowSubLabel(row)}
        </span>
      </span>
      <Progress
        value={percent}
        aria-label={row.name}
        className={cn('h-1.5 w-24 shrink-0', inactive && 'opacity-40')}
      />
      <span className="w-9 shrink-0 text-right text-[13px] tabular-nums text-muted-foreground">
        {percent}%
      </span>
      {/* Cancel is a back-out, not a destructive action: ghost, no color. */}
      <button
        type="button"
        disabled={inactive}
        onClick={() => onCancel(row.uploadId)}
        aria-label={translate(
          'auto.components.terminal.pane.terminal.drop.upload.cancel',
          'Cancel upload'
        )}
        className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-0"
      >
        <XIcon className="size-4" />
      </button>
    </li>
  )
}

function rowSubLabel(row: RuntimeUploadRow): string {
  if (row.status === 'cancelled') {
    return translate('auto.components.terminal.pane.terminal.drop.upload.cancelled', 'Cancelled')
  }
  if (row.status === 'failed') {
    return translate('auto.components.terminal.pane.terminal.drop.upload.failed', 'Failed')
  }
  return formatTransferredOfTotal(row.sentBytes, row.totalBytes)
}
