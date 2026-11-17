// "Move to this computer" confirm, on the app's unified confirmation dialog: title, one body line,
// at most one note, the archive-afterwards choice in the footer's start slot, and Cancel / Move
// with Move as the default.
import React, { useId, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { DialogCancel, DialogWarning } from '@/components/ui/dialog-parts'
import { useTranslate } from '@/i18n/use-translate'
import { effectiveArchiveAfter, type CloudMoveState } from '@/lib/orca-cloud/orca-cloud-move-store'
import type { CloudMoveConflicts } from './CloudMoveToComputerView'

type ConfirmState = Extract<CloudMoveState, { stage: 'confirm' }>

export function CloudMoveConfirmDialog({
  state,
  conflicts,
  runningAgents,
  onConfirm,
  onClose,
  onArchiveAfterChange
}: {
  state: ConfirmState
  conflicts: CloudMoveConflicts
  /** Agents working in the cloud workspace now: archiving afterwards would stop them. */
  runningAgents: number
  onConfirm: () => void
  onClose: () => void
  onArchiveAfterChange: (archiveAfter: boolean) => void
}): React.JSX.Element {
  const t = useTranslate()
  const move = useRef<HTMLButtonElement>(null)
  const archiveId = useId()
  const taken = conflicts.branchCheckedOutLocally
  const archiveAfter = effectiveArchiveAfter(state.archiveAfter, runningAgents)
  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent
        size="confirm"
        // Move is the default: focused, so Enter moves.
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          move.current?.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {t('orcaCloudMove.confirm.title', 'Move {{name}} to this computer?', {
              name: state.name
            })}
          </DialogTitle>
          <DialogDescription>
            {t(
              'orcaCloudMove.confirm.body',
              'Copies its branch, uncommitted changes and agent chats into a local workspace. Ignored files stay in the cloud.'
            )}
          </DialogDescription>
        </DialogHeader>
        {taken ? (
          <DialogWarning>
            {t(
              'orcaCloudMove.confirm.branchTakenLine',
              '{{branch}} is already checked out here, so it gets a new name.',
              { branch: taken.branch }
            )}
          </DialogWarning>
        ) : null}
        {state.archived ? (
          <DialogDescription>
            {t(
              'orcaCloudMove.confirm.archivedStays',
              'It’s archived: Orca unarchives it to copy it, then archives it again.'
            )}
          </DialogDescription>
        ) : runningAgents > 0 && archiveAfter ? (
          <DialogWarning>
            {t('orcaCloudMove.confirm.stopsAgents', 'Stops {{count}} running agents', {
              count: runningAgents,
              defaultValue_one: 'Stops {{count}} running agent'
            })}
          </DialogWarning>
        ) : null}
        <DialogFooter
          start={
            state.archived ? null : (
              <>
                <Checkbox
                  id={archiveId}
                  checked={archiveAfter}
                  onCheckedChange={(checked) => onArchiveAfterChange(checked === true)}
                />
                <Label htmlFor={archiveId} variant="dialog">
                  {t('orcaCloudMove.confirm.archiveCloudCopy', 'Archive the cloud copy afterwards')}
                </Label>
              </>
            )
          }
        >
          <DialogCancel />
          <Button ref={move} size="sm" onClick={onConfirm}>
            {t('orcaCloudMove.confirm.action', 'Move')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
