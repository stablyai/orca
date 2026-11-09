import type React from 'react'
import { CircleCheck, Download, ExternalLink, FolderOpen, MonitorDown, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { InlineError } from '@/components/ui/inline-error'
import { Progress } from '@/components/ui/progress'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { formatElapsedTime } from '@/components/worktree-creation/worktree-creation-clock'
import { formatBytes } from '../../../../../../shared/format-bytes'
import type { RuntimeDownloadErrorCode } from '../../../../../../shared/runtime-downloads/runtime-download-contract'
import type { RuntimeDownloadProgressSnapshot } from '@/runtime/files/downloads/runtime-download-progress-store'
import {
  runtimeDownloadFailureCopy,
  runtimeDownloadNoAppCopy,
  type RuntimeDownloadFailureAction,
  type RuntimeDownloadPlace
} from './runtime-download-failure-copy'

export type { RuntimeDownloadPlace }
export type RuntimeDownloadItemKind = 'file' | 'folder'
export type RuntimeDownloadToastIntent = 'save' | 'open'

export type RuntimeDownloadToastState =
  | {
      kind: 'progress'
      intent: RuntimeDownloadToastIntent
      itemKind: RuntimeDownloadItemKind
      /** Local name being written, e.g. `src.zip`. */
      name: string
      snapshot: RuntimeDownloadProgressSnapshot | null
    }
  | {
      kind: 'done'
      itemKind: RuntimeDownloadItemKind
      /** Name of the saved file on this computer. */
      name: string
      bytes: number
      elapsedMs: number
      fileCount?: number
      excludedDefaultDirs?: boolean
      skippedCount?: number
      /** False for files the OS would run: those are only revealed, never opened from the toast. */
      canOpen?: boolean
    }
  | {
      kind: 'failed'
      intent: RuntimeDownloadToastIntent
      itemKind: RuntimeDownloadItemKind
      name: string
      code: RuntimeDownloadErrorCode
      place: RuntimeDownloadPlace
    }
  | { kind: 'no_app'; name: string }

export type RuntimeDownloadToastAction = 'cancel' | 'open' | RuntimeDownloadFailureAction

const countFormat = new Intl.NumberFormat()
const formatCount = (value: number): string => countFormat.format(value)
// A time-left estimate from the first second of a transfer swings wildly; wait for the rate to settle.
const ETA_MIN_RATE_WINDOW_MS = 2_000

// Titles truncate at the end in CSS, which hides the extension; shorten long names in the middle.
const MAX_TITLE_NAME_CHARS = 40

export function middleTruncateName(name: string, max = MAX_TITLE_NAME_CHARS): string {
  const chars = Array.from(name)
  if (chars.length <= max) {
    return name
  }
  const tail = Math.floor((max - 1) / 2)
  const head = max - 1 - tail
  return `${chars.slice(0, head).join('')}…${chars.slice(chars.length - tail).join('')}`
}

const CARD =
  'relative w-[356px] rounded-lg border border-border bg-popover px-3 py-2.5 text-sm text-popover-foreground shadow-lg'

/** Fraction done, or null while the size is unknown (folder walk, empty file). */
export function runtimeDownloadFraction(
  snapshot: RuntimeDownloadProgressSnapshot | null
): number | null {
  if (!snapshot || snapshot.phase !== 'transferring' || !snapshot.totalBytes) {
    return null
  }
  return Math.min(1, snapshot.processedBytes / snapshot.totalBytes)
}

function progressDetail(
  t: Translate,
  itemKind: RuntimeDownloadItemKind,
  snapshot: RuntimeDownloadProgressSnapshot | null
): string {
  if (!snapshot || snapshot.phase === 'preparing') {
    return itemKind === 'folder'
      ? t('components.runtimeDownload.collectingFiles', 'Collecting files…')
      : t('components.runtimeDownload.starting', 'Starting…')
  }
  if (itemKind === 'folder') {
    // Counted in files, not bytes: the source size and the ZIP size differ, and the done card
    // reports the ZIP's size.
    return snapshot.fileCount === undefined
      ? formatBytes(snapshot.receivedBytes)
      : t('components.runtimeDownload.folderFilesProgress', '{{files}} files', {
          count: snapshot.fileCount,
          files: formatCount(snapshot.fileCount),
          defaultValue_one: '{{files}} file'
        })
  }
  const amount = snapshot.totalBytes
    ? t('components.runtimeDownload.amountOfTotal', '{{done}} of {{total}}', {
        done: formatBytes(snapshot.receivedBytes),
        total: formatBytes(snapshot.totalBytes)
      })
    : formatBytes(snapshot.receivedBytes)
  const rate = snapshot.bytesPerSecond
  if (!rate || rate <= 0) {
    return amount
  }
  if (snapshot.totalBytes && snapshot.rateWindowMs >= ETA_MIN_RATE_WINDOW_MS) {
    const leftMs = (Math.max(0, snapshot.totalBytes - snapshot.receivedBytes) / rate) * 1000
    return t('components.runtimeDownload.amountRateEta', '{{amount}} · {{rate}}/s · {{eta}} left', {
      amount,
      rate: formatBytes(rate),
      eta: formatElapsedTime(leftMs)
    })
  }
  return t('components.runtimeDownload.amountAndRate', '{{amount}} · {{rate}}/s', {
    amount,
    rate: formatBytes(rate)
  })
}

function DismissButton({ onDismiss }: { onDismiss: () => void }): React.JSX.Element {
  const t = useTranslate()
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      aria-label={t('components.runtimeDownload.dismiss', 'Dismiss')}
      className="absolute top-1.5 right-1.5"
      onClick={onDismiss}
    >
      <X aria-hidden />
    </Button>
  )
}

function ProgressCard({
  state,
  onAction
}: {
  state: Extract<RuntimeDownloadToastState, { kind: 'progress' }>
  onAction: (action: RuntimeDownloadToastAction) => void
}): React.JSX.Element {
  const t = useTranslate()
  const fraction = runtimeDownloadFraction(state.snapshot)
  const percent = fraction === null ? null : Math.round(fraction * 100)
  const detail = progressDetail(t, state.itemKind, state.snapshot)
  const title =
    state.intent === 'open'
      ? t('components.runtimeDownload.opening', 'Opening {{name}}', {
          name: middleTruncateName(state.name)
        })
      : t('components.runtimeDownload.downloading', 'Downloading {{name}}', {
          name: middleTruncateName(state.name)
        })
  const progressLabel = t('components.runtimeDownload.progressLabel', 'Download progress')
  const Icon = state.intent === 'open' ? MonitorDown : Download
  return (
    <div className={CARD}>
      <div className="flex items-center gap-3">
        <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        {/* Only the title is live: the numbers change several times a second and would chatter.
            The progressbar's value text carries them when asked. */}
        <p role="status" className="min-w-0 flex-1 truncate font-medium" title={state.name}>
          {title}
        </p>
        <Button type="button" variant="outline" size="xs" onClick={() => onAction('cancel')}>
          {t('components.runtimeDownload.cancel', 'Cancel')}
        </Button>
      </div>
      <div className="mt-2 space-y-1.5 ps-7">
        {percent === null ? (
          // Unknown size: an honest sweep beats a faked percentage.
          <span
            role="progressbar"
            aria-label={progressLabel}
            aria-valuetext={detail}
            className="block h-1.5 w-full overflow-hidden rounded-full bg-primary/20"
          >
            <span className="block h-full w-2/5 animate-[skill-update-slide_1.35s_ease-in-out_infinite] rounded-full bg-primary motion-reduce:w-full motion-reduce:animate-none motion-reduce:opacity-40" />
          </span>
        ) : (
          <Progress
            value={percent}
            aria-label={progressLabel}
            aria-valuetext={`${percent}%, ${detail}`}
            className="h-1.5"
          />
        )}
        <p className="truncate text-xs tabular-nums text-muted-foreground">{detail}</p>
      </div>
    </div>
  )
}

function DoneCard({
  state,
  revealLabel,
  onAction,
  onDismiss
}: {
  state: Extract<RuntimeDownloadToastState, { kind: 'done' }>
  revealLabel: string
  onAction: (action: RuntimeDownloadToastAction) => void
  onDismiss: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const isFolder = state.itemKind === 'folder'
  const size = isFolder
    ? t('components.runtimeDownload.zipSize', '{{size}} zip', { size: formatBytes(state.bytes) })
    : formatBytes(state.bytes)
  const parts =
    isFolder && state.fileCount !== undefined
      ? [
          t('components.runtimeDownload.fileCount', '{{files}} files', {
            count: state.fileCount,
            files: formatCount(state.fileCount),
            defaultValue_one: '{{files}} file'
          }),
          size
        ]
      : [size]
  parts.push(formatElapsedTime(state.elapsedMs))
  const notes: string[] = []
  if (state.excludedDefaultDirs) {
    notes.push(
      t(
        'components.runtimeDownload.defaultDirsNotIncluded',
        'node_modules and .git weren’t included.'
      )
    )
  }
  if ((state.skippedCount ?? 0) > 0) {
    notes.push(
      t(
        'components.runtimeDownload.skipped',
        '{{count}} items couldn’t be read and were left out.',
        {
          count: state.skippedCount,
          defaultValue_one: '{{count}} item couldn’t be read and was left out.'
        }
      )
    )
  }
  return (
    <div role="status" className={`${CARD} pe-9`}>
      <div className="flex items-start gap-3">
        <CircleCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1 space-y-0.5">
          <p className="truncate font-medium" title={state.name}>
            {t('components.runtimeDownload.downloaded', 'Downloaded {{name}}', {
              name: middleTruncateName(state.name)
            })}
          </p>
          <p className="text-xs tabular-nums text-muted-foreground">{parts.join(' · ')}</p>
          {notes.map((note) => (
            <p key={note} className="text-xs text-muted-foreground">
              {note}
            </p>
          ))}
          <div className="flex gap-2 pt-1.5">
            <Button type="button" variant="outline" size="xs" onClick={() => onAction('reveal')}>
              <FolderOpen aria-hidden />
              {revealLabel}
            </Button>
            {state.itemKind === 'file' && state.canOpen !== false ? (
              <Button type="button" variant="outline" size="xs" onClick={() => onAction('open')}>
                <ExternalLink aria-hidden />
                {t('components.runtimeDownload.open', 'Open')}
              </Button>
            ) : null}
          </div>
        </div>
      </div>
      <DismissButton onDismiss={onDismiss} />
    </div>
  )
}

function actionLabel(t: Translate, action: RuntimeDownloadFailureAction, revealLabel: string) {
  switch (action) {
    case 'retry':
      return t('components.runtimeDownload.retry', 'Try again')
    case 'download_instead':
      return t('components.runtimeDownload.downloadInstead', 'Download')
    case 'refresh':
      return t('components.runtimeDownload.refresh', 'Refresh')
    case 'reveal':
      return revealLabel
  }
}

/**
 * Toast for a download from a runtime host: live progress with Cancel, a done card whose actions
 * open the result on this computer, or one error with at most one next action.
 */
export function RuntimeDownloadToast({
  state,
  revealLabel,
  onAction,
  onDismiss
}: {
  state: RuntimeDownloadToastState
  /** Platform name for revealing a path, e.g. "Reveal in Finder". */
  revealLabel: string
  onAction: (action: RuntimeDownloadToastAction) => void
  onDismiss: () => void
}): React.JSX.Element {
  const t = useTranslate()
  if (state.kind === 'progress') {
    return <ProgressCard state={state} onAction={onAction} />
  }
  if (state.kind === 'done') {
    return (
      <DoneCard state={state} revealLabel={revealLabel} onAction={onAction} onDismiss={onDismiss} />
    )
  }
  const copy =
    state.kind === 'no_app'
      ? runtimeDownloadNoAppCopy(t, state.name)
      : runtimeDownloadFailureCopy(t, state)
  const action = copy.action
  return (
    <div className="relative w-[356px] rounded-lg bg-popover shadow-lg">
      <InlineError
        layout="toast"
        tone={copy.tone}
        title={copy.title}
        detail={copy.detail}
        action={
          action ? (
            <Button type="button" variant="outline" size="xs" onClick={() => onAction(action)}>
              {actionLabel(t, action, revealLabel)}
            </Button>
          ) : undefined
        }
      />
      <DismissButton onDismiss={onDismiss} />
    </div>
  )
}
