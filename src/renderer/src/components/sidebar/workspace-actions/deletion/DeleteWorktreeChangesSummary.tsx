// @protected-copy
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type JSX } from 'react'
import { Check, CircleAlert } from 'lucide-react'
import { DialogDisclosure } from '@/components/ui/dialog-parts'
import { LoadingSpinner } from '@/components/ui/LoadingSpinner'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { STATUS_COLORS } from '../../../../lib/source-control/paths/git-path-decoration'
import { STATUS_LABELS } from '../../../../../../shared/git/status/git-status-labels'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import type { DeleteWorktreeLocalFilesState } from './use-delete-worktree-at-risk-local-files'
import { DeleteWorktreeLocalFilesDetails } from './DeleteWorktreeLocalFilesHint'
import { DeleteWorktreeRelativePath } from './delete-worktree-relative-path'
import type {
  DeleteWorktreeChangeCheckState,
  DeleteWorktreeDirtyChangePreview
} from './delete-worktree-dirty-change-counts'

type UnsavedFile = { id: string; relativePath?: string; filePath: string }

/** One consequence sentence, leaving out loss categories absent from the scan results. */
export function deleteWorktreeLossLine(
  changeCount: number | undefined,
  unsavedFileCount: number,
  t: Translate = translate,
  hasIgnoredFiles = false
): string | null {
  const changes =
    changeCount === undefined
      ? null
      : changeCount > 0
        ? t('worktree.delete.loss.changes', '{{count}} uncommitted changes', {
            count: changeCount,
            defaultValue_one: '{{count}} uncommitted change'
          })
        : // A dirty worktree whose files were not counted still loses its changes.
          t('worktree.delete.loss.uncountedChanges', 'Uncommitted changes')
  const files =
    unsavedFileCount > 0
      ? t('worktree.delete.loss.unsavedFiles', '{{count}} unsaved files', {
          count: unsavedFileCount,
          defaultValue_one: '{{count}} unsaved file'
        })
      : null
  if (hasIgnoredFiles) {
    if (changes && files) {
      return t(
        'worktree.delete.loss.all',
        '{{changes}}, {{files}} and ignored files will be lost',
        { changes, files }
      )
    }
    const what = changes ?? files
    return what
      ? t('worktree.delete.loss.withIgnored', '{{what}} and ignored files will be lost', { what })
      : t('worktree.delete.loss.ignoredOnly', 'Ignored files will be lost')
  }
  if (changes && files) {
    return t('worktree.delete.loss.both', '{{changes}} and {{files}} will be lost', {
      changes,
      files
    })
  }
  const only = changes ?? files
  return only ? t('worktree.delete.loss.one', '{{what}} will be lost', { what: only }) : null
}

type StatusTone = 'checking' | 'clean' | 'warning'

// size-3.5 chevron plus the trigger's gap-1.5.
const CHEVRON_ROOM_PX = 20

/** What deleting one workspace loses, as one fixed-height line; the files sit behind it. */
export function DeleteWorktreeChangesSummary({
  worktree,
  dirtyChanges,
  unsavedFiles,
  atRiskLocalFilesByIdentity
}: {
  worktree: Worktree
  dirtyChanges: {
    counts: ReadonlyMap<string, number>
    checkStates: ReadonlyMap<string, DeleteWorktreeChangeCheckState>
    previews: ReadonlyMap<string, DeleteWorktreeDirtyChangePreview>
  }
  unsavedFiles: readonly UnsavedFile[]
  atRiskLocalFilesByIdentity: ReadonlyMap<string, DeleteWorktreeLocalFilesState>
}): JSX.Element | null {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const [overflow, setOverflow] = useState({ px: 0, inToggle: false })
  const [focused, setFocused] = useState(false)
  const [opened, setOpened] = useState(false)
  const textRef = useRef<HTMLSpanElement>(null)
  const noteRef = useRef<HTMLSpanElement>(null)
  // A long translation can clip the one fixed line; the full sentence then moves into the panel.
  const measureClipped = useCallback(() => {
    const spans = [textRef.current, noteRef.current].filter((el) => el != null)
    const px = spans.reduce((total, el) => total + el.scrollWidth - el.clientWidth, 0)
    const inToggle = spans[0]?.closest('button') != null
    setOverflow((current) =>
      current.px === px && current.inToggle === inToggle ? current : { px, inToggle }
    )
  }, [])
  // Text changes don't fire ResizeObserver, so remeasure after every render too.
  useLayoutEffect(measureClipped)
  const key = worktree.hostId ? getWorktreeHostIdentity(worktree) : worktree.id
  const changeCount = dirtyChanges.counts.get(key)
  const checkState = dirtyChanges.checkStates.get(key)
  const preview = dirtyChanges.previews.get(key)
  const localFilesState = atRiskLocalFilesByIdentity.get(getWorktreeHostIdentity(worktree))
  const atRiskLocalFiles =
    localFilesState?.status === 'complete' ? localFilesState.files : undefined
  const loss = deleteWorktreeLossLine(
    changeCount,
    unsavedFiles.length,
    t,
    (atRiskLocalFiles?.count ?? 0) > 0
  )
  // A refused delete's fallback count is not a finished check, so follow the Git check itself.
  const changesChecking = checkState === 'checking'
  const changesFailed = checkState === 'unavailable'
  const ignoredChecking = localFilesState?.status === 'checking'
  const ignoredUnchecked =
    localFilesState?.status === 'unsupported' ||
    (atRiskLocalFiles !== undefined && atRiskLocalFiles.count === 0 && !atRiskLocalFiles.complete)
  const checkingLabel = t('components.workspace.delete.changes.checking', 'Checking for changes…')
  const failedLabel = t(
    'components.workspace.delete.changes.unavailable',
    'Changes could not be checked'
  )
  // Show the Git result as soon as it lands; a trailing spinner covers the ignored-files scan.
  const [tone, text]: [StatusTone, string] | [null, null] = loss
    ? ['warning', loss]
    : changesFailed
      ? ['warning', failedLabel]
      : changesChecking || (ignoredChecking && checkState !== 'complete')
        ? [ignoredUnchecked ? 'warning' : 'checking', checkingLabel]
        : // An open panel outlives its last loss (e.g. an autosave), so it never collapses on its own.
          checkState === 'complete'
          ? [
              ignoredUnchecked ? 'warning' : 'clean',
              t('components.workspace.delete.changes.none', 'No uncommitted changes')
            ]
          : open || focused
            ? ['clean', t('components.workspace.delete.changes.noUnsaved', 'No unsaved files')]
            : [null, null]
  const stillChecking = tone !== 'checking' && (changesChecking || ignoredChecking)
  // Secondary facts stay on the collapsed line so a failed check never hides a known loss.
  const note = [
    loss && changesFailed ? failedLabel : null,
    localFilesState?.status === 'unsupported'
      ? t('components.workspace.delete.ignoredFiles.unavailable', 'Ignored files not checked')
      : ignoredUnchecked
        ? t(
            'components.workspace.delete.ignoredFilesUnchecked',
            'Ignored files could not be fully checked'
          )
        : null
  ]
    .filter(Boolean)
    .join(' · ')
  const changedFiles = preview?.files ?? []
  const ignoredPaths = atRiskLocalFiles?.paths ?? atRiskLocalFiles?.samplePaths ?? []
  const hasDetails = changedFiles.length > 0 || unsavedFiles.length > 0 || ignoredPaths.length > 0
  // An open or focused toggle outlives its last loss, so an autosave never collapses or unfocuses it.
  const keepsToggle = hasDetails || open || focused
  // A toggle that exists only because of clipping takes the chevron's room from the text itself.
  const clipped = overflow.px > (overflow.inToggle && !keepsToggle ? CHEVRON_ROOM_PX : 0)
  const expandable = keepsToggle || clipped
  const rowRef = useRef<HTMLDivElement>(null)
  const hasRow = tone !== null
  useEffect(() => {
    const row = rowRef.current
    if (!row || typeof ResizeObserver === 'undefined') {
      return
    }
    const observer = new ResizeObserver(measureClipped)
    observer.observe(row)
    // A font load or font setting change alters text width without resizing the row.
    document.fonts?.addEventListener('loadingdone', measureClipped)
    const fontSetting = new MutationObserver(measureClipped)
    fontSetting.observe(document.documentElement, { attributeFilter: ['style'] })
    return () => {
      observer.disconnect()
      fontSetting.disconnect()
      document.fonts?.removeEventListener('loadingdone', measureClipped)
    }
  }, [hasRow, measureClipped])
  if (!tone) {
    return null
  }
  const fullText = note ? `${text} · ${note}` : text
  const line = (
    <span className="flex min-w-0 items-center gap-1.5" title={fullText}>
      <span
        aria-hidden="true"
        className={`flex size-3.5 shrink-0 items-center justify-center ${tone === 'checking' ? 'text-muted-foreground' : ''}`}
      >
        {tone === 'checking' ? (
          <LoadingSpinner className="size-3.5" />
        ) : tone === 'clean' ? (
          <Check className="size-3.5 text-status-success" />
        ) : (
          <CircleAlert className="size-3.5" />
        )}
      </span>
      <span ref={textRef} className="min-w-0 truncate">
        {text}
      </span>
      {note ? (
        // A zero flex basis gives the note only leftover room, so the main sentence stays whole.
        <span ref={noteRef} className="min-w-0 flex-1 truncate text-muted-foreground">
          · {note}
        </span>
      ) : null}
      {stillChecking ? (
        <>
          <span aria-hidden="true" className="flex shrink-0 text-muted-foreground">
            <LoadingSpinner className="size-3" />
          </span>
          {changesChecking && text === checkingLabel ? null : (
            <span className="sr-only">
              {changesChecking
                ? checkingLabel
                : t('components.workspace.delete.ignoredFiles.checking', 'Checking ignored files…')}
            </span>
          )}
        </>
      ) : null}
    </span>
  )
  const toneClassName = tone === 'warning' ? 'text-status-warning-text' : 'text-muted-foreground'
  return (
    <div
      ref={rowRef}
      aria-live="polite"
      className="min-w-0"
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        const row = event.currentTarget
        // Unmount the toggle only after focus lands, or Tab would fall back to the dialog.
        setTimeout(() => setFocused(row.contains(document.activeElement)))
      }}
    >
      {expandable ? (
        <DialogDisclosure
          label={line}
          variant="code"
          status={tone === 'warning' ? 'warning' : 'muted'}
          open={open}
          onOpenChange={(next) => {
            setOpen(next)
            setOpened(true)
          }}
        >
          {clipped || !hasDetails ? (
            <p className="mb-2 font-sans text-[13px] text-foreground">{fullText}</p>
          ) : null}
          {/* Rows mount on first open and stay, so neither opening nor reopening rebuilds them early. */}
          {opened && ignoredPaths.length > 0 && atRiskLocalFiles ? (
            <MemoLocalFilesDetails files={atRiskLocalFiles} />
          ) : null}
          {opened ? (
            <DeleteWorktreeChangesFileList preview={preview} unsavedFiles={unsavedFiles} />
          ) : null}
        </DialogDisclosure>
      ) : null}
      {expandable ? null : (
        <p className={`flex h-5 min-w-0 items-center gap-1.5 text-[13px] ${toneClassName}`}>
          {line}
        </p>
      )}
    </div>
  )
}

// The ignored-files list changes only when its scan publishes, never on focus or resize.
const MemoLocalFilesDetails = memo(DeleteWorktreeLocalFilesDetails)

/** Memoized so status, scan and focus updates of the line never rebuild a long list. */
const DeleteWorktreeChangesFileList = memo(function DeleteWorktreeChangesFileList({
  preview,
  unsavedFiles
}: {
  preview: DeleteWorktreeDirtyChangePreview | undefined
  unsavedFiles: readonly UnsavedFile[]
}): JSX.Element {
  const t = useTranslate()
  return (
    <>
      <ul className="min-w-0 space-y-0.5">
        {(preview?.files ?? []).map((file) => (
          <li key={file.path} className="flex min-w-0 items-baseline gap-2">
            <span
              className="w-3 shrink-0 font-semibold"
              style={{ color: STATUS_COLORS[file.status] }}
              aria-label={file.status}
            >
              {STATUS_LABELS[file.status]}
            </span>
            <span className="min-w-0 break-all text-foreground">
              <DeleteWorktreeRelativePath path={file.path} />
              {file.hasUnresolvedConflict ? (
                <span className="ml-2 font-sans text-destructive">
                  {t(
                    'auto.components.sidebar.DeleteWorktreeDirtyChangeHint.unresolvedConflict',
                    'Unresolved conflict'
                  )}
                </span>
              ) : null}
            </span>
          </li>
        ))}
        {unsavedFiles.map((file) => (
          <li key={file.id} className="flex min-w-0 items-baseline gap-2">
            <span className="w-3 shrink-0" aria-hidden="true" />
            <span className="min-w-0 break-all text-foreground" title={file.filePath}>
              {file.relativePath || file.filePath}{' '}
              <span className="font-sans text-muted-foreground">
                {t('worktree.delete.unsavedSuffix', '(unsaved)')}
              </span>
            </span>
          </li>
        ))}
      </ul>
      {preview && preview.remainingPathCount > 0 ? (
        <p className="mt-1 font-sans">
          {t(
            'auto.components.sidebar.DeleteWorktreeDirtyChangeHint.moreLoadedPaths',
            'and {{count}} more loaded paths',
            {
              count: preview.remainingPathCount,
              defaultValue_one: 'and {{count}} more loaded path'
            }
          )}
        </p>
      ) : null}
    </>
  )
})
