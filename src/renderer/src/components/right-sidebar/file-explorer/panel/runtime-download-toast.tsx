import type React from 'react'
import { CircleCheck, Download, ExternalLink, FolderOpen, RotateCw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { InlineError } from '@/components/ui/inline-error'
import { Progress } from '@/components/ui/progress'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { formatElapsedTime } from '@/components/worktree-creation/worktree-creation-clock'
import { formatBytes } from '../../../../../../shared/format-bytes'
import type { RuntimeDownloadErrorCode } from '../../../../../../shared/runtime-downloads/runtime-download-contract'
import type { RuntimeDownloadProgressSnapshot } from '@/runtime/files/downloads/runtime-download-progress-store'

export type RuntimeDownloadItemKind = 'file' | 'folder'
export type RuntimeDownloadToastIntent = 'save' | 'open'
/** Cloud workspaces live in a sandbox; other runtime hosts are named generically. */
export type RuntimeDownloadPlace = 'sandbox' | 'host'

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

export type RuntimeDownloadToastAction = 'cancel' | 'reveal' | 'open' | 'retry' | 'download_instead'

const countFormat = new Intl.NumberFormat()
const formatCount = (value: number): string => countFormat.format(value)

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
    const amount = snapshot.totalBytes
      ? t('components.runtimeDownload.amountOfTotal', '{{done}} of {{total}}', {
          done: formatBytes(snapshot.processedBytes),
          total: formatBytes(snapshot.totalBytes)
        })
      : formatBytes(snapshot.receivedBytes)
    return snapshot.fileCount === undefined
      ? amount
      : t('components.runtimeDownload.folderProgress', '{{files}} files · {{amount}}', {
          count: snapshot.fileCount,
          files: formatCount(snapshot.fileCount),
          defaultValue_one: '{{files}} file · {{amount}}',
          amount
        })
  }
  const amount = snapshot.totalBytes
    ? t('components.runtimeDownload.amountOfTotal', '{{done}} of {{total}}', {
        done: formatBytes(snapshot.receivedBytes),
        total: formatBytes(snapshot.totalBytes)
      })
    : formatBytes(snapshot.receivedBytes)
  return snapshot.bytesPerSecond && snapshot.bytesPerSecond > 0
    ? t('components.runtimeDownload.amountAndRate', '{{amount}} · {{rate}}/s', {
        amount,
        rate: formatBytes(snapshot.bytesPerSecond)
      })
    : amount
}

function failureCopy(
  t: Translate,
  state: Extract<RuntimeDownloadToastState, { kind: 'failed' }>
): { title: string; detail: string; action: 'retry' | 'download_instead' | null } {
  const { name, place } = state
  const title =
    state.intent === 'open'
      ? t('components.runtimeDownload.openFailedTitle', 'Couldn’t open {{name}}', { name })
      : t('components.runtimeDownload.failedTitle', 'Couldn’t download {{name}}', { name })
  switch (state.code) {
    case 'too_large':
      return state.intent === 'open'
        ? {
            title,
            detail: t(
              'components.runtimeDownload.tooLargeToOpen',
              'Files over 1 GB can’t be opened directly. Download it instead.'
            ),
            action: 'download_instead'
          }
        : {
            title,
            detail: t(
              'components.runtimeDownload.tooLarge',
              'Folders over 2 GB can’t be downloaded at once. Download the folders inside it instead.'
            ),
            action: null
          }
    case 'too_many_entries':
      return {
        title,
        detail: t(
          'components.runtimeDownload.tooManyEntries',
          'Folders with more than 65,000 items can’t be downloaded at once. Download the folders inside it instead.'
        ),
        action: null
      }
    case 'host_update_required':
      return {
        title,
        detail:
          place === 'sandbox'
            ? t(
                'components.runtimeDownload.sandboxUpdateRequired',
                'This sandbox runs an older version of Orca. New cloud workspaces include downloads. Your files are safe.'
              )
            : t(
                'components.runtimeDownload.hostUpdateRequired',
                'The remote host runs an older version of Orca. Update Orca there, then try again.'
              ),
        action: null
      }
    case 'host_busy':
      return {
        title,
        detail: t(
          'components.runtimeDownload.busy',
          'Too many downloads are running. Wait for one to finish, then try again.'
        ),
        action: 'retry'
      }
    case 'not_found':
      return {
        title,
        detail:
          place === 'sandbox'
            ? t(
                'components.runtimeDownload.notFoundInSandbox',
                'It was moved or deleted in the sandbox. Refresh the file explorer to see the latest files.'
              )
            : t(
                'components.runtimeDownload.notFoundOnHost',
                'It was moved or deleted on the remote host. Refresh the file explorer to see the latest files.'
              ),
        action: null
      }
    case 'not_a_file':
    case 'not_a_directory':
      return {
        title,
        detail: t(
          'components.runtimeDownload.changed',
          'It changed while Orca was reading it. Try again.'
        ),
        action: 'retry'
      }
    case 'disconnected':
      return {
        title,
        detail:
          place === 'sandbox'
            ? t(
                'components.runtimeDownload.sandboxDisconnected',
                'The connection to the sandbox dropped. Nothing was saved on this computer.'
              )
            : t(
                'components.runtimeDownload.hostDisconnected',
                'The connection to the remote host dropped. Nothing was saved on this computer.'
              ),
        action: 'retry'
      }
    case 'open_failed':
    case 'transfer_failed':
    case 'canceled':
      return {
        title,
        detail: t(
          'components.runtimeDownload.transferFailed',
          'Something went wrong while copying it. Nothing was saved on this computer.'
        ),
        action: 'retry'
      }
  }
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
    const fraction = runtimeDownloadFraction(state.snapshot)
    const percent = fraction === null ? null : Math.round(fraction * 100)
    const detail = progressDetail(t, state.itemKind, state.snapshot)
    const title =
      state.intent === 'open'
        ? t('components.runtimeDownload.opening', 'Opening {{name}}', { name: state.name })
        : t('components.runtimeDownload.downloading', 'Downloading {{name}}', { name: state.name })
    const progressLabel = t('components.runtimeDownload.progressLabel', 'Download progress')
    return (
      <div role="status" aria-live="polite" className={CARD}>
        <div className="flex items-center gap-3">
          <Download className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <p className="min-w-0 flex-1 truncate font-medium" title={state.name}>
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
  if (state.kind === 'done') {
    const parts =
      state.itemKind === 'folder' && state.fileCount !== undefined
        ? [
            t('components.runtimeDownload.fileCount', '{{files}} files', {
              count: state.fileCount,
              files: formatCount(state.fileCount),
              defaultValue_one: '{{files}} file'
            }),
            formatBytes(state.bytes)
          ]
        : [formatBytes(state.bytes)]
    parts.push(formatElapsedTime(state.elapsedMs))
    const notes: string[] = []
    if (state.excludedDefaultDirs) {
      notes.push(
        t('components.runtimeDownload.leftOutDefaultDirs', 'Left out node_modules and .git.')
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
                name: state.name
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
              {state.itemKind === 'file' ? (
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
  const copy =
    state.kind === 'no_app'
      ? {
          title: t(
            'components.runtimeDownload.noAppTitle',
            'No app on this computer opens {{name}}',
            {
              name: state.name
            }
          ),
          detail: t(
            'components.runtimeDownload.noAppDetail',
            'Orca saved a copy. Reveal it to choose an app.'
          ),
          action: 'reveal' as const
        }
      : failureCopy(t, state)
  const actionLabel =
    copy.action === 'retry'
      ? t('components.runtimeDownload.retry', 'Try again')
      : copy.action === 'download_instead'
        ? t('components.runtimeDownload.downloadInstead', 'Download')
        : revealLabel
  return (
    // The action sits under the text inside the error box: a 356px toast has no room beside it.
    <div className="relative w-[356px] rounded-lg bg-popover shadow-lg">
      <InlineError
        title={copy.title}
        detail={copy.detail}
        className={copy.action ? 'pr-9 pb-11' : 'pr-9'}
      />
      {copy.action ? (
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="absolute bottom-2.5 left-10"
          onClick={() => onAction(copy.action!)}
        >
          {copy.action === 'retry' ? <RotateCw aria-hidden /> : null}
          {actionLabel}
        </Button>
      ) : null}
      <DismissButton onDismiss={onDismiss} />
    </div>
  )
}
