import { getRelativePathInsideRoot } from '@/lib/path'
import { useLayoutEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import { importExternalPathsToRuntime } from '@/runtime/runtime-file-client'
import { translate } from '@/i18n/i18n'
import { createOsFileDropSequence, useOsFileDropOwner } from '@/hooks/use-os-file-drop-owner'
import { getNativeFileDropRejectionMessage } from '@/lib/native-file-drop-rejection-message'
import type { FileExplorerOperationOwner } from './file-explorer-types'
import {
  captureFileExplorerOperationGuard,
  type FileExplorerOperationGuard
} from './file-explorer-operation-owner'

/** Row attribute naming the folder an OS file dropped on that row imports into. */
export const FILE_EXPLORER_DROP_DIR_ATTRIBUTE = 'data-file-explorer-drop-dir'

type UseFileExplorerImportParams = {
  worktreeId: string | null
  worktreePath: string | null
  displayRootPath?: string | null
  refreshDir: (dirPath: string) => Promise<void>
  clearNativeDragState: () => void
  setSelectedPath: (path: string | null) => void
  operationOwner?: FileExplorerOperationOwner
}

type FileExplorerDropDestination =
  | {
      worktreeId: string
      worktreePath: string
      destinationDir: string
      guard: FileExplorerOperationGuard
    }
  | { error: unknown }

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
  // Committed scope, read after the import to decide whether to select the result.
  const shownRef = useRef({ worktreeId, displayRootPath })
  useLayoutEffect(() => {
    shownRef.current = { worktreeId, displayRootPath }
  }, [worktreeId, displayRootPath])
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
        const guard = captureFileExplorerOperationGuard(worktreeId, operationOwner)
        return { worktreeId, worktreePath, destinationDir, guard }
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
        const { destinationDir, guard } = destination
        guard.assertCurrent()
        const { results } = await importExternalPathsToRuntime(
          {
            target: guard.route.target,
            worktreeId: destination.worktreeId,
            worktreePath: destination.worktreePath,
            connectionId: guard.route.connectionId,
            expectedExecutionHostId: guard.route.expectedExecutionHostId,
            expectedSshTargetId: guard.route.expectedSshTargetId,
            expectedSshConnectionGeneration: guard.route.expectedSshConnectionGeneration
          },
          prepared.paths,
          destinationDir,
          { assertCurrent: guard.assertCurrent }
        )

        // Refresh the destination directory once per gesture
        await refreshDir(destinationDir)

        // Why: only select (highlight) the first imported file — don't trigger
        // the full reveal machinery because watcher refreshes can otherwise
        // snap the tree viewport away from the user's drop target.
        const imported = results.filter((r) => r.status === 'imported')
        const skipped = results.filter((r) => r.status === 'skipped')
        const failed = results.filter((r) => r.status === 'failed')

        const shown = shownRef.current
        if (
          imported.length > 0 &&
          shown.worktreeId === destination.worktreeId &&
          getRelativePathInsideRoot(imported[0].destPath, shown.displayRootPath) !== null
        ) {
          setSelectedPath(imported[0].destPath)
        }

        if (failed.length > 0) {
          const noun = failed.length === 1 ? 'file' : 'files'
          toast.error(
            translate(
              'auto.components.right.sidebar.useFileExplorerImport.132fd0e1e9',
              'Failed to import {{value0}} {{value1}}.',
              { value0: failed.length, value1: noun }
            )
          )
        } else if (skipped.length > 0 && imported.length === 0) {
          const noun = skipped.length === 1 ? 'file' : 'files'
          toast.error(
            translate(
              'auto.components.right.sidebar.useFileExplorerImport.25919b2050',
              'Skipped {{value0}} {{value1}}.',
              { value0: skipped.length, value1: noun }
            )
          )
        }
      } catch (err) {
        toast.error(extractIpcErrorMessage(err, 'Failed to import files.'))
      } finally {
        clearNativeDragState()
      }
    }
  })
}
