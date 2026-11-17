// @protected-copy
import type { JSX } from 'react'
import { DialogDisclosure, DialogWarning } from '@/components/ui/dialog-parts'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { formatAtRiskLocalFileNames } from '@/lib/workspace/display/at-risk-local-files-label'
import { STATUS_COLORS } from '../../../../lib/source-control/paths/git-path-decoration'
import { STATUS_LABELS } from '../../../../../../shared/git/status/git-status-labels'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import type { DeleteWorktreeLocalFilesState } from './use-delete-worktree-at-risk-local-files'
import {
  DeleteWorktreeLocalFilesDetails,
  DeleteWorktreeLocalFilesHint
} from './DeleteWorktreeLocalFilesHint'
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

/** What deleting one workspace loses: one amber line, then the files behind "Show changes". */
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
  const status =
    changeCount !== undefined || !checkState || checkState === 'complete'
      ? null
      : checkState === 'unavailable'
        ? t('components.workspace.delete.changes.unavailable', 'Changes could not be checked')
        : t('components.workspace.delete.changes.checking', 'Checking for changes…')
  const ignoredNames =
    atRiskLocalFiles && (atRiskLocalFiles.count > 0 || !atRiskLocalFiles.complete)
      ? formatAtRiskLocalFileNames(atRiskLocalFiles, t)
      : null
  const ignoredNote =
    atRiskLocalFiles && (atRiskLocalFiles.count > 0 || !atRiskLocalFiles.complete)
      ? ignoredNames
        ? t(
            'components.workspace.delete.ignoredFilesLost',
            'Ignored files will be lost: {{names}}',
            {
              names: ignoredNames
            }
          )
        : t(
            'components.workspace.delete.ignoredFilesUnchecked',
            'Ignored files could not be fully checked'
          )
      : null
  const changedFiles = preview?.files ?? []
  const hasIgnoredPaths =
    (atRiskLocalFiles?.paths ?? atRiskLocalFiles?.samplePaths ?? []).length > 0
  const hasDetails = changedFiles.length > 0 || unsavedFiles.length > 0 || hasIgnoredPaths
  if (!loss && !status && !localFilesState) {
    return null
  }
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {loss ? <DialogWarning>{loss}</DialogWarning> : null}
      {status ? <p className="text-[12.5px] text-muted-foreground">{status}</p> : null}
      {localFilesState &&
      (!atRiskLocalFiles || (atRiskLocalFiles.complete && atRiskLocalFiles.count === 0)) ? (
        <DeleteWorktreeLocalFilesHint state={localFilesState} />
      ) : null}
      {!hasDetails && ignoredNote ? (
        <p className="text-settings-detail text-muted-foreground">{ignoredNote}</p>
      ) : null}
      {hasDetails ? (
        <DialogDisclosure label={t('worktree.delete.showChanges', 'Show changes')} variant="code">
          {ignoredNote && !hasIgnoredPaths ? (
            <p className="mb-2 font-sans text-muted-foreground">{ignoredNote}</p>
          ) : null}
          {hasIgnoredPaths && atRiskLocalFiles ? (
            <DeleteWorktreeLocalFilesDetails files={atRiskLocalFiles} />
          ) : null}
          <ul className="min-w-0 space-y-0.5">
            {changedFiles.map((file) => (
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
        </DialogDisclosure>
      ) : null}
    </div>
  )
}

/** Default Delete forces removal, so warn while a target's Git status is unknown. */
export function DeleteWorktreeUnknownChangesWarning(): JSX.Element {
  const t = useTranslate()
  return (
    <DialogWarning>
      {t(
        'components.workspace.delete.changes.permanentLoss',
        'Any uncommitted or untracked changes in Git workspaces will be permanently deleted.'
      )}
    </DialogWarning>
  )
}
