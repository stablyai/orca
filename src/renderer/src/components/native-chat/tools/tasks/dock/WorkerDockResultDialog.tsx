import { useRef, useState } from 'react'
import { ChevronRight, X } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { workerDockResultLabel } from './worker-dock-result-label'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  DialogDescription
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/class-names'
import { NativeChatMarkdown } from '../../../markdown/NativeChatMarkdown'
import type { WorkerDockResult } from '../../../../../../../shared/orchestration/dock/worker-dock'
import { workerDockStateLabel } from './worker-dock-labels'
import { workerDockGlyph, type WorkerDockGlyph as Glyph } from './worker-dock-card-order'
import { WorkerDockGlyph } from './WorkerDockGlyph'
import type { WorkerDockRowView } from './WorkerDockRow'

// The dock rows' keyboard ring, so focus reads the same in the card as in the list it opened from.
const RING = 'focus-visible:ring-2 focus-visible:ring-ring'

/** The first sentence of an error, as plain text, for the card's one reason line. */
export function workerDockReasonLine(text: string): string {
  const plain = text
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
  return /^(.+?[.!?])(?:\s|$)/.exec(plain)?.[1] ?? plain
}

/** The prompt when it says more than the name, which is often its first words cut short. */
function distinctTitle(name: string, title: string): string | null {
  const stem = (value: string) => value.replace(/(?:\.\.\.|…)\s*$/, '').trim()
  const a = stem(name)
  const b = stem(title)
  return !b || a.startsWith(b) || b.startsWith(a) ? null : title
}

function resultGlyph(outcome: WorkerDockResult['outcome'] | undefined): Glyph | null {
  if (outcome === 'failed' || outcome === 'unexpected') {
    return 'failed'
  }
  // Stopped by you is neither a success nor a failure: the label alone says it.
  return outcome === 'stopped' ? null : 'done'
}

/** Whether the card was opened from the keyboard: the element that opened it still holds a
 *  keyboard focus ring. A pointer press leaves none, so the card opens without a ring. */
function openedByKeyboard(): boolean {
  const opener = document.activeElement
  if (!(opener instanceof HTMLElement) || opener === document.body) {
    return false
  }
  try {
    return opener.matches(':focus-visible')
  } catch {
    return false
  }
}

function Details({ text }: { text: string }) {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        aria-expanded={open}
        data-worker-dock-details=""
        className={cn(
          '-ml-0.5 flex w-fit items-center gap-1 rounded-sm text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none',
          RING
        )}
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronRight
          aria-hidden="true"
          className={cn('size-3.5 transition-transform', open && 'rotate-90')}
        />
        {open
          ? t('components.native-chat.workerDock.hideDetails', 'Hide details')
          : t('components.native-chat.workerDock.showDetails', 'Show details')}
      </button>
      {open ? (
        <pre className="scrollbar-sleek max-h-40 overflow-auto overscroll-contain rounded-md bg-muted px-2.5 py-2 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap text-muted-foreground">
          {text}
        </pre>
      ) : null}
    </div>
  )
}

/** A worker's card: its name on one line, its state as the dock's mark and label, one reason line
 *  with the raw error folded under Show details, and its actions at the bottom right. */
export function WorkerDockResultDialog({
  result,
  row,
  error,
  onClose,
  onOpen,
  onRestore,
  onReturnFocus,
  ownerActionsAvailable
}: {
  result: WorkerDockResult | null
  /** The row the card opened from, for its name and state when the saved result is unreadable. */
  row?: WorkerDockRowView
  error: string | null
  onClose: () => void
  onOpen: () => void
  onRestore: () => void
  /** Where focus goes once the dialog lets go of it: the dialog's own focus restore cannot reach a
   *  row the card unmounted meanwhile. */
  onReturnFocus: () => void
  ownerActionsAvailable: boolean
}) {
  const t = useTranslate()
  const openButton = useRef<HTMLButtonElement>(null)
  const name = result?.name ?? row?.name ?? null
  const title = result?.title ?? row?.title ?? ''
  const distinct = name === null ? null : distinctTitle(name, title)
  const headline =
    name === null
      ? t('components.native-chat.workerDock.resultUnavailable', 'Worker result unavailable')
      : distinct || title.length <= name.length
        ? name
        : title
  const status = result
    ? {
        glyph: resultGlyph(result.outcome),
        label: workerDockResultLabel(t, result.outcome),
        failed: result.outcome === 'failed' || result.outcome === 'unexpected'
      }
    : row
      ? {
          glyph: workerDockGlyph(row),
          label: workerDockStateLabel(t, row.state),
          failed: row.state === 'failed' || row.state === 'unexpected'
        }
      : null
  // A failure's body is its raw error: one line up front, the rest on request. A finished
  // worker's body is its report and reads in full. An error beside a loaded result is a failed
  // action (Show in dock again), shown next to the result rather than in place of it.
  const raw = result ? (status?.failed ? result.body : null) : error
  const actionError = result ? error : null
  const reason = raw ? workerDockReasonLine(raw) : null
  // The reason line clamps at two lines, and how much fits depends on the glyphs and the width,
  // not the length: any error keeps its full text one click away.
  const details = Boolean(raw?.trim())
  return (
    <Dialog
      open={result !== null || error !== null}
      onOpenChange={(open) => {
        if (!open) {
          onClose()
        }
      }}
    >
      <DialogContent
        size="flush"
        scrollable
        showCloseButton={false}
        className="sm:max-w-md"
        data-worker-dock-card=""
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          // A keyboard open lands on Open worker with its ring, so the next key has a visible
          // target. A pointer open focuses the card itself: a ring there on every click reads as
          // stuck. Tab and Shift+Tab inside always show the ring.
          if (openedByKeyboard() && openButton.current) {
            openButton.current.focus({ preventScroll: true })
          } else if (event.currentTarget instanceof HTMLElement) {
            event.currentTarget.focus({ preventScroll: true })
          }
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          onReturnFocus()
        }}
      >
        <div className="flex min-w-0 flex-col gap-1 px-4 pt-4 pb-3">
          <div className="flex min-w-0 items-center gap-2">
            <DialogTitle
              size="compact"
              className="min-w-0 flex-1"
              title={[headline, distinct].filter(Boolean).join('\n')}
            >
              <span className="block truncate">{headline}</span>
            </DialogTitle>
            <DialogClose asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className={cn('-mr-1 shrink-0', RING)}
                aria-label={t('components.native-chat.workerDock.close', 'Close')}
              >
                <X className="size-4" />
              </Button>
            </DialogClose>
          </div>
          <DialogDescription asChild>
            <div className="flex min-w-0 items-center gap-1.5 text-xs">
              {status ? (
                <>
                  {status.glyph ? <WorkerDockGlyph glyph={status.glyph} /> : null}
                  <span
                    data-worker-dock-card-state=""
                    className={cn(
                      'truncate',
                      status.failed ? 'text-destructive' : 'text-muted-foreground'
                    )}
                  >
                    {status.label}
                  </span>
                </>
              ) : null}
            </div>
          </DialogDescription>
        </div>
        <div className="flex min-w-0 flex-col gap-2 px-4 pb-3">
          {distinct ? (
            <p className="line-clamp-2 text-sm text-muted-foreground">{distinct}</p>
          ) : null}
          {reason ? (
            <p
              role={result ? undefined : 'alert'}
              data-worker-dock-card-reason=""
              className="line-clamp-2 text-sm text-foreground"
            >
              {reason}
            </p>
          ) : null}
          {raw !== null && details ? <Details text={raw} /> : null}
          {result && raw === null ? <NativeChatMarkdown content={result.body} /> : null}
          {actionError ? (
            <p role="alert" className="text-sm text-destructive">
              {actionError}
            </p>
          ) : null}
        </div>
        <div className="flex items-center justify-end gap-2 px-4 pb-4">
          {result?.acknowledged ? (
            <Button
              variant="ghost"
              size="sm"
              className={RING}
              disabled={!ownerActionsAvailable}
              title={
                ownerActionsAvailable
                  ? undefined
                  : t(
                      'components.native-chat.workerDock.remoteOwner',
                      'Stop or clear this from the computer it runs on'
                    )
              }
              onClick={onRestore}
            >
              {t('components.native-chat.workerDock.restore', 'Show in dock again')}
            </Button>
          ) : null}
          <Button ref={openButton} variant="outline" size="sm" className={RING} onClick={onOpen}>
            {t('components.native-chat.workerDock.openWorker', 'Open worker')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
