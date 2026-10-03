import { useEffect, useState, useSyncExternalStore } from 'react'
import {
  ChevronDownIcon,
  DownloadIcon,
  FileIcon,
  FolderIcon,
  UploadIcon,
  XIcon
} from 'lucide-react'
import { Progress } from '@/components/ui/progress'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import {
  getTransferSession,
  subscribeToTransferSessions,
  summarizeTransferSession,
  toggleTransferCollapsed,
  type TransferDirection,
  type TransferRow
} from './transfer-session-state'
import { formatTransferredOfTotal, toRowPercent } from './transfer-progress-format'
import { formatTransferProgressHeading } from './transfer-progress-heading'

// Long enough to read the outcome, short enough not to linger over the workspace.
const SETTLED_HOLD_MS = 1200
const EXIT_ANIMATION_MS = 200

type Props = {
  sessionId: string
  onCancel: (transferId: string) => void
  /** Closes the toast; the panel owns the timing so the exit is not cut short. */
  onDismiss: () => void
  /** Re-issues the toast: sonner re-measures height only on a new element identity. */
  onLayoutChange: () => void
}

export function TransferProgressPanel({
  sessionId,
  onCancel,
  onDismiss,
  onLayoutChange
}: Props): React.JSX.Element | null {
  const session = useSyncExternalStore(subscribeToTransferSessions, () =>
    getTransferSession(sessionId)
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
  const summary = summarizeTransferSession(session)
  const DirectionIcon = session.direction === 'upload' ? UploadIcon : DownloadIcon
  const heading = formatTransferProgressHeading({
    direction: session.direction,
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
        // Why: what `fill-mode-forwards` sets; the design lint misreads that class as a fill color.
        leaving &&
          'animate-out fade-out-0 zoom-out-95 duration-200 [--tw-animation-fill-mode:forwards]'
      )}
    >
      <div className="flex items-center gap-3 px-3 py-2.5">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-full border border-border">
          <DirectionIcon className="size-3.5" aria-hidden />
        </span>
        <span className="min-w-0 flex-1 truncate text-sm">{heading}</span>
        {/* Fixed width so the row never reflows as the number gains digits. */}
        <span className="w-9 shrink-0 text-right text-sm tabular-nums text-muted-foreground">
          {session.settled || summary.percent === null ? '' : `${summary.percent}%`}
        </span>
        <button
          type="button"
          hidden={session.settled}
          onClick={() => {
            toggleTransferCollapsed(sessionId)
            onLayoutChange()
          }}
          aria-expanded={!collapsed}
          aria-label={
            collapsed
              ? translate('transferProgress.showItems', 'Show items')
              : translate('transferProgress.hideItems', 'Hide items')
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
            <TransferRowItem
              key={row.transferId}
              row={row}
              direction={session.direction}
              onCancel={onCancel}
            />
          ))}
        </ul>
      )}
    </div>
  )
}

function TransferRowItem({
  row,
  direction,
  onCancel
}: {
  row: TransferRow
  direction: TransferDirection
  onCancel: (transferId: string) => void
}): React.JSX.Element {
  // Why: without a known total a percentage would read as 0% forever; show bytes alone.
  // A finished row still reads 100%, even an empty file or folder.
  const percent = row.status === 'done' || row.totalBytes > 0 ? toRowPercent(row) : null
  const inactive = row.status !== 'active'
  const RowIcon = row.kind === 'directory' ? FolderIcon : FileIcon

  return (
    <li className="flex items-center gap-3 px-3 py-2.5">
      <RowIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 overflow-hidden">
        <span className={cn('truncate text-[13px]', inactive && 'text-muted-foreground')}>
          {row.name}
        </span>
        <span className="truncate text-xs text-muted-foreground tabular-nums" title={row.detail}>
          {rowSubLabel(row)}
        </span>
      </span>
      {/* Dimmed through a wrapper: <Progress> owns its own effects. */}
      <div className={cn('w-24 shrink-0', inactive && 'opacity-40')}>
        {percent === null && !inactive ? (
          // Why: bytes are moving toward a total not known yet; a bar parked at 0 reads as stuck.
          <div
            role="progressbar"
            aria-label={row.name}
            className="h-1.5 overflow-hidden rounded-full bg-primary/20"
          >
            <div className="h-full w-2/5 animate-[skill-update-slide_1.35s_ease-in-out_infinite] rounded-full bg-primary motion-reduce:w-full motion-reduce:animate-none motion-reduce:opacity-40" />
          </div>
        ) : (
          <Progress value={percent ?? 0} aria-label={row.name} className="h-1.5" />
        )}
      </div>
      <span className="w-9 shrink-0 text-right text-[13px] tabular-nums text-muted-foreground">
        {percent === null ? '' : `${percent}%`}
      </span>
      {/* Cancel is a back-out, not a destructive action: ghost, no color. */}
      <button
        type="button"
        disabled={inactive}
        onClick={() => onCancel(row.transferId)}
        aria-label={
          direction === 'upload'
            ? translate('transferProgress.cancelUpload', 'Cancel upload')
            : translate('transferProgress.cancelDownload', 'Cancel download')
        }
        className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-0"
      >
        <XIcon className="size-4" />
      </button>
    </li>
  )
}

function rowSubLabel(row: TransferRow): string {
  if (row.status === 'cancelling') {
    return translate('transferProgress.cancelling', 'Cancelling…')
  }
  if (row.status === 'unconfirmed') {
    return translate('transferProgress.cancelUnconfirmed', 'Cancel sent; remote state unconfirmed')
  }
  if (row.status === 'cancelled') {
    // Why: a cancel that could not undo everything must say so; the path is in the tooltip.
    return row.detail
      ? translate('transferProgress.cancelledPartial', 'Cancelled; partial upload left on host')
      : translate('transferProgress.cancelled', 'Cancelled')
  }
  if (row.status === 'failed') {
    return row.detail
      ? translate('transferProgress.failedPartial', 'Failed; partial upload left on host')
      : translate('transferProgress.failed', 'Failed')
  }
  return formatTransferredOfTotal(row.sentBytes, row.totalBytes)
}
