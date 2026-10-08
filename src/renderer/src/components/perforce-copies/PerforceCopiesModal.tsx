import { useCallback, useEffect, useState } from 'react'
import { LoaderCircle, RefreshCw, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
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
import { useAppStore } from '@/store'
import type {
  WorkspaceCopyListEntry,
  WorkspaceCopyListResult
} from '../../../../shared/perforce/workspace-copy/workspace-copy-types'
import { PerforceCopyRequirement } from './PerforceCopyRequirement'
import { findRepoForHost } from '@/store/slices/repo-host-identity'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import { runPerforceCopyOperation } from '../../runtime/runtime-perforce-client'
import { perforceProjectTarget } from '@/lib/perforce-workspace-target'

/** The copy's state in words; null is ready, anything else is something Delete cleans up. */
export function copyProblem(copy: WorkspaceCopyListEntry, serverChecked: boolean): string | null {
  if (!copy.folderExists && !copy.clientExists) {
    return translate('perforce.copies.onlyMarkerLeft', 'Only the marker file is left')
  }
  if (!copy.folderExists) {
    return translate('perforce.copies.folderMissing', 'Folder missing; client still on the server')
  }
  if (serverChecked && !copy.clientExists) {
    return translate(
      'perforce.copies.clientDeleted',
      'Client deleted on the server; folder left behind'
    )
  }
  return null
}

/** Lists every copy of a Perforce project, including leftovers, each with Delete. */
export default function PerforceCopiesModal() {
  const modalData = useAppStore((s) => s.modalData)
  const closeModal = useAppStore((s) => s.closeModal)
  const openModal = useAppStore((s) => s.openModal)
  const repos = useAppStore((s) => s.repos)
  const settings = useAppStore((s) => s.settings)
  const repo =
    typeof modalData.repoId === 'string'
      ? findRepoForHost(repos, modalData.repoId, {
          hostId: typeof modalData.hostId === 'string' ? modalData.hostId : null,
          settings
        })
      : null
  const [listing, setListing] = useState<WorkspaceCopyListResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    if (!repo) {
      return
    }
    setLoading(true)
    setError(null)
    // Sync, not just list: copies made outside Orca join the sidebar and vanished ones leave it.
    const result = await runPerforceCopyOperation(
      perforceProjectTarget(repo.id, getRepoExecutionHostId(repo)),
      'syncCopies',
      {}
    )
    setLoading(false)
    if (result.ok) {
      setListing(result.value)
    } else {
      setError(result.error)
    }
  }, [repo])

  useEffect(() => {
    void load()
  }, [load])

  const remove = (copy: WorkspaceCopyListEntry): void => {
    if (repo) {
      openModal('delete-perforce-copy', {
        repoId: repo.id,
        hostId: getRepoExecutionHostId(repo),
        sourcePath: repo.path,
        copyName: copy.name
      })
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && closeModal()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{translate('perforce.copies.title', 'Perforce copies')}</DialogTitle>
          <DialogDescription>
            {listing
              ? translate(
                  'perforce.copies.listDescription',
                  'Copies of {{client}} in {{folder}}, including any made outside Orca in the same layout.',
                  { client: listing.source.client, folder: listing.copiesDir }
                )
              : translate(
                  'perforce.copies.listDescriptionPending',
                  'Copies of this workspace, including any made outside Orca in the same layout.'
                )}
          </DialogDescription>
        </DialogHeader>
        <PerforceCopyRequirement />

        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        {listing && !listing.serverChecked ? (
          <p className="text-sm text-muted-foreground">
            {translate(
              'perforce.copies.serverUnreachable',
              'The Perforce server could not be asked ({{error}}); showing what is on disk.',
              { error: listing.serverError }
            )}
          </p>
        ) : null}
        {!listing && loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" />
            {translate(
              'perforce.copies.reading',
              'Reading copies from disk and the Perforce server…'
            )}
          </div>
        ) : null}
        {listing && listing.copies.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {translate(
              'perforce.copies.none',
              'No copies yet. Each workspace you create in this project gets its own copy.'
            )}
          </p>
        ) : null}
        {listing && listing.copies.length > 0 ? (
          <ul className="flex max-h-[55vh] flex-col divide-y divide-border overflow-y-auto scrollbar-sleek rounded-md border border-border text-sm">
            {listing.copies.map((copy) => {
              const problem = copyProblem(copy, listing.serverChecked)
              return (
                <li key={copy.name} className="flex items-center gap-3 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium">{copy.name}</span>
                      <Badge variant={problem ? 'destructive' : 'secondary'}>
                        {problem ?? translate('perforce.copies.statusReady', 'Ready')}
                      </Badge>
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {copy.stream ?? translate('perforce.copies.streamUnknown', 'stream unknown')}{' '}
                      · {copy.client}
                    </div>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => remove(copy)}>
                    <Trash2 className="size-3.5" />
                    {translate('perforce.copies.deleteEllipsis', 'Delete…')}
                  </Button>
                </li>
              )
            })}
          </ul>
        ) : null}

        <DialogFooter>
          <Button variant="ghost" onClick={() => void load()} disabled={loading}>
            <RefreshCw className="size-3.5" />
            {translate('perforce.copies.refresh', 'Refresh')}
          </Button>
          <Button variant="secondary" onClick={closeModal}>
            {translate('perforce.copies.close', 'Close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
