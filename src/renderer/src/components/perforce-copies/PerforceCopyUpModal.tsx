import { useEffect, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import { toast } from 'sonner'
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
import { perforceProjectTarget } from '@/lib/perforce-workspace-target'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import type { WorkspaceCopyUpPreview } from '../../../../shared/perforce/workspace-copy/workspace-copy-types'
import { runPerforceCopyOperation } from '../../runtime/runtime-perforce-client'
import { FileSample, SummaryList } from './perforce-copy-delete-sections'
import type { PerforceCopyUpTarget } from './perforce-copy-target'

const FILE_SAMPLE = 20

function readTarget(data: Record<string, unknown>): PerforceCopyUpTarget | null {
  const { repoId, sourcePath, copyName, stream, parent } = data
  const host = typeof data.hostId === 'string' ? parseExecutionHostId(data.hostId) : null
  return typeof repoId === 'string' &&
    typeof sourcePath === 'string' &&
    typeof copyName === 'string' &&
    typeof stream === 'string' &&
    typeof parent === 'string' &&
    host
    ? { repoId, hostId: host.id, sourcePath, copyName, stream, parent }
    : null
}

/**
 * Shows what copying a Perforce copy's own stream up into its parent would submit, and submits it
 * only on confirm. The work runs in a throwaway client, so the user's workspace is never touched.
 */
export default function PerforceCopyUpModal() {
  const modalData = useAppStore((s) => s.modalData)
  const closeModal = useAppStore((s) => s.closeModal)
  const [target] = useState(() => readTarget(modalData))
  const [preview, setPreview] = useState<WorkspaceCopyUpPreview | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!target) {
      return
    }
    let cancelled = false
    void runPerforceCopyOperation(
      perforceProjectTarget(target.repoId, target.hostId),
      'previewCopyUp',
      { name: target.copyName }
    ).then((result) => {
      if (cancelled) {
        return
      }
      if (result.ok) {
        setPreview(result.value)
      } else {
        setLoadError(result.error)
      }
    })
    return () => {
      cancelled = true
    }
  }, [target])

  const confirm = async (): Promise<void> => {
    if (!target || !preview || preview.upToDate) {
      return
    }
    setPending(true)
    setError(null)
    const result = await runPerforceCopyOperation(
      perforceProjectTarget(target.repoId, target.hostId),
      'copyUp',
      { name: target.copyName }
    )
    setPending(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    toast.success(
      translate('perforce.copies.copiedUp', 'Submitted change {{change}} to {{parent}}', {
        change: result.value.submittedChange,
        parent: result.value.parent
      }),
      {
        description: [
          ...result.value.warnings,
          translate(
            'perforce.copies.copiedUpNext',
            'Delete the copy once you no longer need it; its stream goes with it.'
          )
        ].join(' ')
      }
    )
    closeModal()
  }

  const parent = preview?.parent ?? target?.parent ?? ''
  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && !pending && closeModal()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {translate('perforce.copies.copyUpTitle', 'Copy “{{name}}” up to {{parent}}?', {
              name: target?.copyName ?? '',
              parent
            })}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'perforce.copies.copyUpDescription',
              'Submits the work submitted on {{stream}} to {{parent}} in one changelist. It runs in a temporary client, so your workspace and its checked-out files are not touched.',
              { stream: target?.stream ?? '', parent }
            )}
          </DialogDescription>
        </DialogHeader>

        {!preview && !loadError ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" />
            {translate('perforce.copies.copyUpChecking', 'Checking what would be copied up…')}
          </div>
        ) : null}
        {loadError ? <p className="text-sm text-destructive">{loadError}</p> : null}
        {preview?.upToDate ? (
          <p className="text-sm text-muted-foreground">
            {translate(
              'perforce.copies.copyUpNothing',
              '{{parent}} already has everything on {{stream}}; there is nothing to copy up.',
              { parent: preview.parent, stream: preview.stream }
            )}
          </p>
        ) : null}
        {preview && !preview.upToDate ? (
          <div className="flex max-h-[55vh] min-w-0 flex-col gap-3 overflow-x-hidden overflow-y-auto scrollbar-sleek text-sm">
            <SummaryList
              title={translate('perforce.copies.copyUpChanges', 'Changes on the copy’s stream')}
              items={preview.changes.map(
                (change) => `${change.change}: ${change.description.split(/\r?\n/)[0] ?? ''}`
              )}
            />
            <div>
              <div className="font-medium">
                {translate('perforce.copies.copyUpFiles', '{{files}} file(s) to submit', {
                  files: preview.files.length
                })}
              </div>
              <FileSample
                files={preview.files
                  .slice(0, FILE_SAMPLE)
                  .map((file) => `${file.depotFile} (${file.action})`)}
                total={preview.files.length}
              />
            </div>
          </div>
        ) : null}

        {error ? <p className="text-sm text-destructive">{error}</p> : null}

        <DialogFooter>
          <Button variant="ghost" onClick={closeModal} disabled={pending}>
            {translate('perforce.copies.cancel', 'Cancel')}
          </Button>
          <Button
            className="w-40"
            onClick={() => void confirm()}
            disabled={!preview || preview.upToDate || pending}
          >
            {pending ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : (
              translate('perforce.copies.copyUpSubmit', 'Copy up and submit')
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
