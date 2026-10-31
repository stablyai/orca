import { toast } from 'sonner'
import type {
  PerforceChangelist,
  PerforceEntry,
  PerforceOperationResult,
  PerforceShelvedFile
} from '../../../../../shared/perforce/perforce-types'
import type { PerforceSettings } from '../../../../../shared/perforce/perforce-settings'
import type { ChangelistActions } from './perforce-changelist-section'
import {
  generatePerforceDescription,
  perforceOperationsFor,
  type PerforceWorkspaceTarget
} from '../../../runtime/runtime-perforce-client'
import { translate } from '@/i18n/i18n'

type Run = (
  operation: () => Promise<PerforceOperationResult>,
  successMessage?: string
) => Promise<boolean>

const paths = (entries: PerforceEntry[]): string[] => entries.map((entry) => entry.path)

/** Mutations behind the changelist headers and file menus: shelving, submitting, deleting, AI descriptions. */
export function usePerforceChangelistActions({
  target,
  run,
  busy,
  settings,
  openShelvedFile
}: {
  target: PerforceWorkspaceTarget
  busy: boolean
  run: Run
  settings: PerforceSettings
  openShelvedFile: (file: PerforceShelvedFile, changelist: number, viewOnly: boolean) => void
}) {
  const p4 = perforceOperationsFor(target)
  const ask = (question: string, enabled: boolean): boolean => !enabled || window.confirm(question)

  const generateDescription = async (
    changelist: 'default' | 'new' | number,
    filePaths: string[]
  ): Promise<string | null> => {
    if (filePaths.length === 0) {
      toast.error(
        translate(
          'perforce.ui.openFilesInThisChangelistFirst',
          'Open files in this changelist first.'
        )
      )
      return null
    }
    // Why catch: a relay or handler failure rejects, and callers rely on null to re-enable their buttons.
    const result = await generatePerforceDescription(target, { changelist, filePaths }).catch(
      (error: unknown) => ({
        success: false as const,
        error: error instanceof Error ? error.message : String(error)
      })
    )
    if (!result.success) {
      toast.error(result.error)
      return null
    }
    return result.message
  }

  // Why: p4 refuses to submit a changelist that has a shelf, so a shelved-only changelist is restored and its shelf dropped first; "keep copy" parks the shelf in a new changelist beforehand.
  const submitShelvedOnly = async (
    changelist: PerforceChangelist
  ): Promise<PerforceOperationResult> => {
    const id = changelist.id
    if (settings.shelfAfterSubmit === 'keep-copy') {
      const created = await p4('createChangelist', {
        description: translate(
          'perforce.ui.shelfBackupDescription',
          'Shelf backup of changelist {{id}}',
          {
            id
          }
        ),
        filePaths: []
      })
      if (!created.success || !created.changelist) {
        return created
      }
      const backupId = created.changelist
      const copied = await p4('unshelveFrom', {
        sourceChangelist: id,
        changelist: backupId
      })
      if (!copied.success) {
        return copied
      }
      const parked = await p4('shelve', {
        changelist: backupId
      })
      if (!parked.success) {
        return parked
      }
      const mapped = changelist.shelvedFiles.flatMap((file) => (file.path ? [file.path] : []))
      if (mapped.length > 0) {
        await p4('close', {
          filePaths: mapped
        })
      }
    }
    const unshelved = await p4('unshelve', {
      changelist: id
    })
    if (!unshelved.success) {
      return unshelved
    }
    const dropped = await p4('deleteShelf', {
      changelist: id
    })
    return dropped.success
      ? p4('submit', {
          changelist: id
        })
      : dropped
  }

  /** Shelves each selected file into its own changelist, then reverts it. */
  const shelveChanges = (targets: PerforceEntry[]): void => {
    const byChangelist = new Map<number, string[]>()
    for (const file of targets) {
      if (typeof file.changelist === 'number') {
        byChangelist.set(file.changelist, [...(byChangelist.get(file.changelist) ?? []), file.path])
      }
    }
    void run(async () => {
      let last: PerforceOperationResult = {
        success: true,
        output: ''
      }
      for (const [changelist, filePaths] of byChangelist) {
        last = await p4('shelveAndRevertFiles', {
          changelist,
          filePaths
        })
        if (!last.success) {
          break
        }
      }
      return last
    }, 'Shelved changes')
  }

  const buildActions = (
    changelist: PerforceChangelist,
    files: PerforceEntry[]
  ): ChangelistActions => ({
    busy,
    onEditDescription: (description) =>
      run(
        () =>
          p4('editDescription', {
            changelist: changelist.id,
            description
          }),
        'Description updated'
      ),
    onGenerateDescription: () => generateDescription(changelist.id, paths(files)),
    onShelve: () =>
      void run(
        () =>
          p4('shelve', {
            changelist: changelist.id
          }),
        'Shelved'
      ),
    onUnshelve: () =>
      void run(
        () =>
          p4('unshelve', {
            changelist: changelist.id
          }),
        'Unshelved'
      ),
    onDiffShelved: (file) => openShelvedFile(file, changelist.id, false),
    onOpenShelved: (file) => openShelvedFile(file, changelist.id, true),
    onUnshelveFile: (file) =>
      void run(
        () =>
          p4('unshelveFiles', {
            changelist: changelist.id,
            depotPaths: [file.depotPath]
          }),
        'Unshelved file'
      ),
    onDeleteWithFiles: () => {
      if (
        ask(
          `Delete changelist ${changelist.id}? Its shelved and opened files are reverted. This cannot be undone.`,
          settings.confirmDestructiveActions
        )
      ) {
        void run(
          () =>
            p4('deleteChangelistWithFiles', {
              changelist: changelist.id
            }),
          `Deleted changelist ${changelist.id}`
        )
      }
    },
    onCopyNumber: () => void window.navigator.clipboard.writeText(String(changelist.id)),
    onDeleteShelf: () => {
      if (
        ask(
          `Revert the shelved files of changelist ${changelist.id}? The shelf is deleted.`,
          settings.confirmDestructiveActions
        )
      ) {
        void run(
          () =>
            p4('deleteShelf', {
              changelist: changelist.id
            }),
          'Shelf deleted'
        )
      }
    },
    onSubmit: () => {
      const shelvedOnly = files.length === 0
      const confirmed = shelvedOnly
        ? ask(
            `Submit the shelved files of changelist ${changelist.id}? They are unshelved first and the shelf is ${
              settings.shelfAfterSubmit === 'keep-copy'
                ? 'copied to a new changelist, then removed'
                : 'deleted'
            }.`,
            settings.confirmShelvedOnlySubmit
          )
        : ask(`Submit changelist ${changelist.id}?`, settings.confirmSubmit)
      if (!confirmed) {
        return
      }
      void run(
        () =>
          shelvedOnly
            ? submitShelvedOnly(changelist)
            : p4('submit', {
                changelist: changelist.id
              }),
        `Submitted changelist ${changelist.id}`
      )
    },
    onDelete: () =>
      void run(() =>
        p4('deleteChangelist', {
          changelist: changelist.id
        })
      )
  })

  const unshelve = (source: number, changelist: 'default' | number): Promise<boolean> =>
    run(
      () =>
        p4('unshelveFrom', {
          sourceChangelist: source,
          changelist
        }),
      `Unshelved changelist ${source}`
    )

  const unshelveIntoNew = async (source: number, description: string): Promise<boolean> => {
    let newCl: number | undefined
    const created = await run(() =>
      p4('createChangelist', {
        description,
        filePaths: []
      }).then((r) => {
        newCl = r.changelist
        return r
      })
    )
    if (!created || newCl == null) {
      return false
    }
    return run(
      () =>
        p4('unshelveFrom', {
          sourceChangelist: source,
          changelist: newCl!
        }),
      `Unshelved changelist ${source}`
    )
  }

  return { ask, generateDescription, shelveChanges, buildActions, unshelve, unshelveIntoNew }
}
