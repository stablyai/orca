import { deleteRuntimePath } from '@/runtime/runtime-file-mutation-client'
import type { ClipboardImageImport } from '../../../../shared/clipboard-image-import'
import { commitFileExplorerOp } from './fileExplorerUndoRedo'
import type {
  FileExplorerImportDestination,
  useFileExplorerImportOperation
} from './use-file-explorer-import-operation'

export function recordFileExplorerImagePaste(args: {
  destination: FileExplorerImportDestination
  snapshot: ClipboardImageImport
  importedPath: string
  importPaths: ReturnType<typeof useFileExplorerImportOperation>['importPaths']
  refreshAfterUndo: () => Promise<void>
  release: (handle: string) => Promise<boolean>
}): void {
  const { destination, snapshot, importPaths, refreshAfterUndo, release } = args
  let importedPath = args.importedPath
  commitFileExplorerOp({
    undo: async () => {
      const route = destination.guard.assertCurrent()
      await deleteRuntimePath(
        { ...route, worktreeId: destination.worktreeId, worktreePath: destination.worktreePath },
        importedPath,
        false
      )
      // UI refresh failures must not lose a filesystem operation that already succeeded.
      await refreshAfterUndo().catch((error) => {
        console.error('Failed to refresh after undoing an image paste:', error)
      })
    },
    redo: async () => {
      let imported = false
      try {
        const results = await importPaths(destination, [snapshot.path], {
          requireExistingDestination: true,
          onImported: (path) => {
            importedPath = path
            imported = true
          }
        })
        if (!imported) {
          const failure = results.find((result) => result.status === 'failed')
          throw new Error(failure?.reason ?? 'Failed to import files.')
        }
      } catch (error) {
        if (!imported) {
          throw error
        }
        console.error('Failed to refresh after redoing an image paste:', error)
      }
    },
    dispose: () => release(snapshot.handle)
  })
}
