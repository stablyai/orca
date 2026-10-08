import { translate } from '@/i18n/i18n'
import { countedProgramNames } from './perforce-copy-holder-groups'
import type {
  WorkspaceCopyRemovalOptions,
  WorkspaceCopyRemovalPreview
} from '../../../../shared/perforce/workspace-copy/workspace-copy-types'

export type CopyRemovalSummary = {
  /** What removal deletes, in the order it happens. */
  deletes: string[]
  /** What it leaves alone, so the user knows their own work is safe. */
  keeps: string[]
}

function quoted(description: string): string {
  const firstLine = description.split(/\r?\n/)[0]?.trim() ?? ''
  return firstLine ? ` “${firstLine.length > 60 ? `${firstLine.slice(0, 57)}…` : firstLine}”` : ''
}

/** The confirmation's account of what deleting this copy does with the options as chosen. */
export function summarizeCopyRemoval(
  preview: WorkspaceCopyRemovalPreview,
  options: WorkspaceCopyRemovalOptions,
  sourceRoot: string
): CopyRemovalSummary {
  const deletes: string[] = []
  const keeps: string[] = [
    translate(
      'perforce.copies.keepsSource',
      'Your workspace {{folder}}, its client and its checked-out files are not touched.',
      { folder: sourceRoot }
    )
  ]
  const ended = (preview.holders ?? []).filter((holder) =>
    options.endHolders?.some(
      (consent) => consent.pid === holder.pid && consent.startedAt === holder.startedAt
    )
  )
  if (ended.length > 0) {
    deletes.push(
      translate(
        'perforce.copies.endsPrograms',
        'Ends {{programs}} first; anything unsaved in them is lost.',
        { programs: countedProgramNames(ended) }
      )
    )
  }
  if (preview.folderExists) {
    deletes.push(
      translate('perforce.copies.deletesFolder', 'The folder {{folder}} and everything in it.', {
        folder: preview.copyRoot
      })
    )
  }
  if (preview.openFiles.count > 0 && options.revertOpenFiles) {
    deletes.push(
      translate(
        'perforce.copies.deletesOpenFiles',
        'The changes in {{files}} checked-out file(s): they are reverted, then deleted with the folder.',
        { files: preview.openFiles.count }
      )
    )
  }
  for (const change of preview.pendingChanges) {
    if (change.shelvedFiles === 0) {
      deletes.push(
        translate(
          'perforce.copies.deletesPending',
          'Pending changelist {{change}}{{description}}.',
          {
            change: change.change,
            description: quoted(change.description)
          }
        )
      )
    } else if (options.deleteShelves) {
      deletes.push(
        translate(
          'perforce.copies.deletesShelved',
          'Changelist {{change}}{{description}} and its {{files}} shelved file(s).',
          {
            change: change.change,
            description: quoted(change.description),
            files: change.shelvedFiles
          }
        )
      )
    }
  }
  if (preview.clientExists) {
    deletes.push(
      translate('perforce.copies.deletesClient', 'The Perforce client {{client}} on the server.', {
        client: preview.client
      })
    )
  }
  if (preview.childStream) {
    const { stream, submittedChanges, parent } = preview.childStream
    if (submittedChanges === 0) {
      deletes.push(
        translate(
          'perforce.copies.deletesStream',
          "The copy's own stream {{stream}} (nothing was submitted to it).",
          { stream }
        )
      )
    } else {
      keeps.push(
        translate(
          'perforce.copies.keepsStream',
          'The stream {{stream}}: it has submitted work. Bring it into {{parent}} with p4 copy -S {{stream}}, then delete the stream.',
          { stream, parent: parent ?? translate('perforce.copies.itsParent', 'its parent') }
        )
      )
    }
  }
  deletes.push(
    translate('perforce.copies.deletesMarker', "The copy's marker file {{file}}.", {
      file: preview.markerPath
    })
  )
  return { deletes, keeps }
}
