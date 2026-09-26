import { toast } from 'sonner'
import type {
  PerforceChangelist,
  PerforceEntry,
  PerforceOperationResult,
  PerforceShelvedFile
} from '../../../../../shared/perforce/perforce-types'
import type { PerforceSettings } from '../../../../../shared/perforce/perforce-settings'
import type { ChangelistActions } from './perforce-changelist-section'
import type { PerforceTarget } from './use-perforce-status'

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
  target: PerforceTarget
  busy: boolean
  run: Run
  settings: PerforceSettings
  openShelvedFile: (file: PerforceShelvedFile, changelist: number, viewOnly: boolean) => void
}) {
  const api = window.api.perforce
  const ask = (question: string, enabled: boolean): boolean => !enabled || window.confirm(question)

  const generateDescription = async (
    changelist: 'default' | 'new' | number,
    filePaths: string[]
  ): Promise<string | null> => {
    if (filePaths.length === 0) {
      toast.error('Open files in this changelist first.')
      return null
    }
    const result = await api.generateDescription({ ...target, changelist, filePaths })
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
      const created = await api.createChangelist({
        ...target,
        description: `Shelf backup of changelist ${id}`,
        filePaths: []
      })
      if (!created.success || !created.changelist) {
        return created
      }
      const backupId = created.changelist
      const copied = await api.unshelveFrom({
        ...target,
        sourceChangelist: id,
        changelist: backupId
      })
      if (!copied.success) {
        return copied
      }
      const parked = await api.shelve({ ...target, changelist: backupId })
      if (!parked.success) {
        return parked
      }
      const mapped = changelist.shelvedFiles.flatMap((file) => (file.path ? [file.path] : []))
      if (mapped.length > 0) {
        await api.close({ ...target, filePaths: mapped })
      }
    }
    const unshelved = await api.unshelve({ ...target, changelist: id })
    if (!unshelved.success) {
      return unshelved
    }
    const dropped = await api.deleteShelf({ ...target, changelist: id })
    return dropped.success ? api.submit({ ...target, changelist: id }) : dropped
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
      let last: Awaited<ReturnType<typeof api.shelveAndRevertFiles>> = {
        success: true,
        output: ''
      }
      for (const [changelist, filePaths] of byChangelist) {
        last = await api.shelveAndRevertFiles({ ...target, changelist, filePaths })
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
          api.editDescription({
            ...target,
            changelist: changelist.id,
            description
          }),
        'Description updated'
      ),
    onGenerateDescription: () => generateDescription(changelist.id, paths(files)),
    onShelve: () => void run(() => api.shelve({ ...target, changelist: changelist.id }), 'Shelved'),
    onUnshelve: () =>
      void run(() => api.unshelve({ ...target, changelist: changelist.id }), 'Unshelved'),
    onDiffShelved: (file) => openShelvedFile(file, changelist.id, false),
    onOpenShelved: (file) => openShelvedFile(file, changelist.id, true),
    onUnshelveFile: (file) =>
      void run(
        () =>
          api.unshelveFiles({
            ...target,
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
            api.deleteChangelistWithFiles({
              ...target,
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
        void run(() => api.deleteShelf({ ...target, changelist: changelist.id }), 'Shelf deleted')
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
            : api.submit({ ...target, changelist: changelist.id }),
        `Submitted changelist ${changelist.id}`
      )
    },
    onDelete: () =>
      void run(() =>
        api.deleteChangelist({
          ...target,
          changelist: changelist.id
        })
      )
  })

  return { ask, generateDescription, shelveChanges, buildActions }
}
