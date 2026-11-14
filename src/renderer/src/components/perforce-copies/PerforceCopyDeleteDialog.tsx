import { useEffect, useState } from 'react'
import { LoaderCircle, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'
import type {
  WorkspaceCopyRemovalPreview,
  WorkspaceCopyRemovalResult
} from '../../../../shared/perforce/workspace-copy/workspace-copy-types'
import {
  FileSample,
  HoldersWarning,
  OptInWarning,
  SummaryList
} from './perforce-copy-delete-sections'
import { summarizeCopyRemoval } from './perforce-copy-removal-summary'
import type { PerforceCopyDeleteTarget } from './perforce-copy-target'
import { runPerforceCopyOperation } from '../../runtime/runtime-perforce-client'
import { perforceProjectTarget } from '@/lib/perforce-workspace-target'

type Props = {
  target: PerforceCopyDeleteTarget | null
  onClose: () => void
  onDeleted: (result: WorkspaceCopyRemovalResult) => void
}

/**
 * Asks before deleting a Perforce workspace copy, listing exactly what goes and what stays. Checked-out
 * files, shelves and programs holding the copy each need their own opt-in; nothing is deleted until
 * the user confirms.
 */
export function PerforceCopyDeleteDialog({ target, onClose, onDeleted }: Props) {
  const [preview, setPreview] = useState<WorkspaceCopyRemovalPreview | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [revertOpenFiles, setRevertOpenFiles] = useState(false)
  const [deleteShelves, setDeleteShelves] = useState(false)
  const [endHolders, setEndHolders] = useState(false)
  const [checks, setChecks] = useState(0)
  const [checking, setChecking] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [shownTarget, setShownTarget] = useState(target)
  if (shownTarget !== target) {
    // Why during render: another copy must never show this one's preview or choices, even briefly.
    setShownTarget(target)
    setPreview(null)
    setRevertOpenFiles(false)
    setDeleteShelves(false)
  }

  // Why not reset above: Check again re-reads the copy without undoing the user's other choices.
  useEffect(() => {
    setLoadError(null)
    setError(null)
    // The consent covers the programs on screen; a re-check may list others.
    setEndHolders(false)
    if (!target) {
      return
    }
    let cancelled = false
    setChecking(true)
    void runPerforceCopyOperation(
      perforceProjectTarget(target.repoId, target.hostId),
      'previewCopyRemoval',
      { name: target.copyName }
    ).then((result) => {
      if (cancelled) {
        return
      }
      setChecking(false)
      if (result.ok) {
        setPreview(result.value)
      } else {
        setLoadError(result.error)
      }
    })
    return () => {
      cancelled = true
    }
  }, [target, checks])

  const holders = preview?.holders ?? []
  const endable = holders.filter((holder) => holder.canEnd !== false)
  const consents = endHolders ? endable.map(({ pid, startedAt }) => ({ pid, startedAt })) : []
  const blocked =
    !preview ||
    checking ||
    (preview.blockers.openFiles && !revertOpenFiles) ||
    (preview.blockers.shelves && !deleteShelves) ||
    endable.length < holders.length ||
    (endable.length > 0 && !endHolders)

  const confirm = async (): Promise<void> => {
    if (!target || blocked) {
      return
    }
    setPending(true)
    setError(null)
    const result = await runPerforceCopyOperation(
      perforceProjectTarget(target.repoId, target.hostId),
      'removeCopy',
      {
        name: target.copyName,
        revertOpenFiles,
        deleteShelves,
        ...(consents.length > 0 ? { endHolders: consents } : {})
      }
    )
    setPending(false)
    if (result.ok) {
      onDeleted(result.value)
      onClose()
    } else {
      setError(result.error)
    }
  }

  const summary = preview
    ? summarizeCopyRemoval(
        preview,
        { revertOpenFiles, deleteShelves, endHolders: consents },
        target?.sourcePath ?? ''
      )
    : null
  const shelved = preview?.pendingChanges.filter((change) => change.shelvedFiles > 0) ?? []

  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && !pending && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {translate('perforce.copies.deleteTitle', 'Delete Perforce copy “{{name}}”?', {
              name: target?.copyName ?? ''
            })}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'perforce.copies.deleteDescription',
              'This deletes the copy on this computer, its client on the Perforce server and its own stream if nothing was submitted to it. It cannot be undone.'
            )}
          </DialogDescription>
        </DialogHeader>

        {!preview && !loadError ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" />
            {translate(
              'perforce.copies.checkingCopy',
              'Checking the copy for checked-out files, changelists and shelves…'
            )}
          </div>
        ) : null}
        {loadError ? <p className="text-sm text-destructive">{loadError}</p> : null}

        {preview && summary ? (
          <div className="flex max-h-[55vh] min-w-0 flex-col gap-3 overflow-x-hidden overflow-y-auto scrollbar-sleek text-sm">
            {!preview.clientExists ? (
              <p className="text-muted-foreground">
                {translate(
                  'perforce.copies.clientGone',
                  'The client {{client}} is no longer on the server; only files on this computer are left to delete.',
                  { client: preview.client }
                )}
              </p>
            ) : null}
            {preview.openFiles.count > 0 ? (
              <OptInWarning
                id="perforce-copy-revert"
                checked={revertOpenFiles}
                onChange={setRevertOpenFiles}
                label={translate(
                  'perforce.copies.revertOptIn',
                  'Revert them and lose their changes'
                )}
              >
                {translate(
                  'perforce.copies.openFilesWarning',
                  '{{files}} file(s) are checked out in this copy. Submit or shelve anything you want to keep first.',
                  { files: preview.openFiles.count }
                )}
                <FileSample files={preview.openFiles.sample} total={preview.openFiles.count} />
              </OptInWarning>
            ) : null}
            {shelved.length > 0 ? (
              <OptInWarning
                id="perforce-copy-shelves"
                checked={deleteShelves}
                onChange={setDeleteShelves}
                label={translate('perforce.copies.shelvesOptIn', 'Delete the shelved files too')}
              >
                {translate(
                  'perforce.copies.shelvesWarning',
                  '{{changes}} shelved file(s). Anyone who has not unshelved them yet loses them.',
                  {
                    changes: shelved
                      .map((change) =>
                        translate(
                          'perforce.copies.changelistHas',
                          'Changelist {{change}} has {{files}}',
                          {
                            change: change.change,
                            files: change.shelvedFiles
                          }
                        )
                      )
                      .join('; ')
                  }
                )}
              </OptInWarning>
            ) : null}
            {holders.length > 0 ? (
              <HoldersWarning
                holders={holders}
                copyRoot={preview.copyRoot}
                checked={endHolders}
                onChange={setEndHolders}
                onCheckAgain={() => setChecks((count) => count + 1)}
                checking={checking}
              />
            ) : null}
            {/* A relay that predates holder details only names the programs. */}
            {!preview.holders && preview.processesHoldingFolder.length > 0 ? (
              <p className="flex gap-2 text-muted-foreground">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                {translate(
                  'perforce.copies.closePrograms',
                  'Close these programs first; Windows will not delete a folder they have open: {{programs}}.',
                  { programs: preview.processesHoldingFolder.join(', ') }
                )}
              </p>
            ) : null}
            <SummaryList
              title={translate('perforce.copies.deletedHeading', 'Deleted')}
              items={summary.deletes}
            />
            <SummaryList
              title={translate('perforce.copies.keptHeading', 'Kept')}
              items={summary.keeps}
            />
          </div>
        ) : null}

        {error ? <p className="text-sm text-destructive">{error}</p> : null}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            {translate('perforce.copies.cancel', 'Cancel')}
          </Button>
          <Button
            variant="destructive"
            className="w-32"
            onClick={() => void confirm()}
            disabled={blocked || pending}
          >
            {pending ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : (
              translate('perforce.copies.deleteCopy', 'Delete copy')
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
