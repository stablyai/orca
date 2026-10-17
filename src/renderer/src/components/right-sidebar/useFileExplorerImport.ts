import { getRelativePathInsideRoot } from '@/lib/path'
import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import { createOsFileDropSequence, useOsFileDropOwner } from '@/hooks/use-os-file-drop-owner'
import { getNativeFileDropRejectionMessage } from '@/lib/native-file-drop-rejection-message'
import {
  useFileExplorerImportOperation,
  type FileExplorerImportParams,
  type FileExplorerImportDestination
} from './use-file-explorer-import-operation'

/** Row attribute naming the folder an OS file dropped on that row imports into. */
export const FILE_EXPLORER_DROP_DIR_ATTRIBUTE = 'data-file-explorer-drop-dir'

type UseFileExplorerImportParams = FileExplorerImportParams & {
  clearNativeDragState: () => void
}

type FileExplorerDropDestination = FileExplorerImportDestination | { error: unknown }

function readDropDir(root: HTMLElement | null, target: EventTarget | null): string | null {
  const row =
    target instanceof Element ? target.closest(`[${FILE_EXPLORER_DROP_DIR_ATTRIBUTE}]`) : null
  return row && root?.contains(row) ? row.getAttribute(FILE_EXPLORER_DROP_DIR_ATTRIBUTE) : null
}

/**
 * Makes the explorer tree root the owner of OS file drops: the target folder is
 * read from the row under the cursor at drop time, then imported, refreshed and selected.
 */
export function useFileExplorerImport({
  worktreeId,
  worktreePath,
  displayRootPath = worktreePath,
  refreshDir,
  clearNativeDragState,
  setSelectedPath,
  operationOwner
}: UseFileExplorerImportParams): (root: HTMLElement | null) => void {
  const rootRef = useRef<HTMLElement | null>(null)
  const [sequence] = useState(createOsFileDropSequence)
  const { captureDestination, importPaths } = useFileExplorerImportOperation({
    worktreeId,
    worktreePath,
    displayRootPath,
    refreshDir,
    setSelectedPath,
    operationOwner
  })
  const resolveDropDir = (event: DragEvent): string | null => {
    // Why: worktreePath is null while the files view is hidden behind search or a closed sidebar.
    if (!worktreeId || !worktreePath || !displayRootPath) {
      return null
    }
    const dir = readDropDir(rootRef.current, event.target) ?? displayRootPath
    return getRelativePathInsideRoot(dir, displayRootPath) === null ? null : dir
  }

  return useOsFileDropOwner<FileExplorerDropDestination | null>(rootRef, {
    consumer: 'main-reader',
    sequence,
    canAccept: (event) => resolveDropDir(event) !== null,
    captureDestination: (event) => {
      const destinationDir = resolveDropDir(event)
      if (!destinationDir || !worktreeId || !worktreePath) {
        return null
      }
      try {
        return captureDestination(destinationDir)
      } catch (error) {
        return { error }
      }
    },
    onDrop: async (prepared, { destination }) => {
      for (const failure of prepared.failures) {
        const message = getNativeFileDropRejectionMessage(failure)
        toast.error(message.title, { description: message.description })
      }
      if (!destination || prepared.paths.length === 0) {
        clearNativeDragState()
        return
      }
      try {
        if ('error' in destination) {
          throw destination.error
        }
        await importPaths(destination, prepared.paths)
      } catch (err) {
        toast.error(extractIpcErrorMessage(err, 'Failed to import files.'))
      } finally {
        clearNativeDragState()
      }
    }
  })
}
