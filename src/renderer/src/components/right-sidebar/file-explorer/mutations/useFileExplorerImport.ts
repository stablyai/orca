import { getRelativePathInsideRoot } from '@/lib/path'
import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { extractIpcErrorMessage } from '@/runtime/errors/ipc-error'
import { useTranslate } from '@/i18n/use-translate'
import { isEditableTarget } from '@/lib/text-input/focus/editable-target'
import {
  createOsFileDropSequence,
  useOsFileDropOwner
} from '@/lib/files/drop/use-os-file-drop-owner'
import { getNativeFileDropRejectionMessage } from '@/lib/files/drop/native-file-drop-rejection-message'
import { prepareOsFileDropPaths } from '@/lib/files/drop/os-file-drop-preparation'
import { readFileExplorerDropDir, readFileExplorerPasteDir } from './file-explorer-drop-directory'
import {
  captureExplorerClipboardRevision,
  markExplorerPasteComplete,
  readClipboardPastePreview,
  readClipboardImportPaths
} from './file-explorer-clipboard-import'
import { importPreparedFileExplorerPaths } from './file-explorer-import-results'
import { useFileExplorerKeyboardPasteConfirmation } from './use-file-explorer-keyboard-paste-confirmation'
import type { FileExplorerOperationOwner } from '../tree/file-explorer-types'
import {
  captureFileExplorerOperationGuard,
  type FileExplorerOperationGuard
} from '../navigation/file-explorer-operation-owner'

export { FILE_EXPLORER_DROP_DIR_ATTRIBUTE } from './file-explorer-drop-directory'

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

type FileExplorerImportController = {
  fileDropOwnerRef: (root: HTMLElement | null) => void
  pasteToDirectory: (directory?: string | null) => void
  keyboardPasteConfirmationOpen: boolean
  cancelKeyboardPasteConfirmation: () => void
  confirmKeyboardPasteConfirmation: (dontAskAgain: boolean) => void
}

function enqueueFileExplorerPasteDelivery(
  sequence: { deliveryTail: Promise<void> },
  deliver: () => Promise<void>
): void {
  sequence.deliveryTail = sequence.deliveryTail
    .then(deliver)
    .catch((error: unknown) => console.error('File explorer paste delivery failed', error))
}

export function useFileExplorerImport({
  worktreeId,
  worktreePath,
  displayRootPath = worktreePath,
  refreshDir,
  clearNativeDragState,
  setSelectedPath,
  operationOwner
}: UseFileExplorerImportParams): FileExplorerImportController {
  const t = useTranslate()
  const rootRef = useRef<HTMLElement | null>(null)
  const [sequence] = useState(createOsFileDropSequence)
  // Read committed scope after import so speculative navigation cannot select into the wrong workspace.
  const shownRef = useRef({ worktreeId, displayRootPath })
  useLayoutEffect(() => {
    shownRef.current = { worktreeId, displayRootPath }
  }, [worktreeId, displayRootPath])

  const importPreparedPaths = useCallback(
    (
      paths: string[],
      destination: Exclude<FileExplorerDropDestination, { error: unknown }>
    ): Promise<string[]> => {
      return importPreparedFileExplorerPaths(paths, destination, {
        refreshDir,
        setSelectedPath,
        getShownScope: () => shownRef.current,
        t
      })
    },
    [refreshDir, setSelectedPath, t]
  )

  const pasteToDirectory = useCallback(
    (directory?: string | null): void => {
      const root = rootRef.current
      if (!root || !worktreeId || !worktreePath || !displayRootPath) {
        return
      }

      const destinationDir = directory ?? displayRootPath
      if (getRelativePathInsideRoot(destinationDir, displayRootPath) === null) {
        return
      }

      let destination: Exclude<FileExplorerDropDestination, { error: unknown }>
      try {
        const guard = captureFileExplorerOperationGuard(worktreeId, operationOwner)
        destination = {
          worktreeId,
          worktreePath,
          destinationDir,
          guard
        }
      } catch (error) {
        toast.error(
          extractIpcErrorMessage(
            error,
            translate(
              'auto.components.right.sidebar.useFileExplorerImport.importFailed',
              'Failed to import files.'
            )
          )
        )
        return
      }

      const revision = captureExplorerClipboardRevision()
      const clipboardRead = readClipboardImportPaths().catch((error: unknown) => {
        toast.error(
          extractIpcErrorMessage(
            error,
            translate(
              'auto.components.right.sidebar.useFileExplorerImport.importFailed',
              'Failed to import files.'
            )
          )
        )
        return null
      })

      enqueueFileExplorerPasteDelivery(sequence, async () => {
        try {
          const paths = await clipboardRead
          if (!paths || paths.length === 0) {
            return
          }
          const prepared = await prepareOsFileDropPaths(paths, 'main-reader')
          for (const failure of prepared.failures) {
            const message = getNativeFileDropRejectionMessage(failure)
            toast.error(message.title, { description: message.description })
          }
          const importedPaths = await importPreparedPaths(prepared.paths, destination)
          if (importedPaths.length > 0) {
            if (importedPaths.length === paths.length) {
              markExplorerPasteComplete(revision)
            }
            toast.success(
              t(
                'auto.components.right.sidebar.useFileExplorerImport.pasteSuccess',
                importedPaths.length === 1 ? 'Pasted {{count}} item' : 'Pasted {{count}} items',
                {
                  count: importedPaths.length,
                  defaultValue_one: 'Pasted {{count}} item'
                }
              ),
              {
                description: importedPaths.join('\n')
              }
            )
          }
        } catch (error) {
          toast.error(
            extractIpcErrorMessage(
              error,
              translate(
                'auto.components.right.sidebar.useFileExplorerImport.importFailed',
                'Failed to import files.'
              )
            )
          )
        }
      })
    },
    [displayRootPath, importPreparedPaths, operationOwner, sequence, t, worktreeId, worktreePath]
  )

  const {
    open: keyboardPasteConfirmationOpen,
    request: requestKeyboardPasteConfirmation,
    cancel: cancelKeyboardPasteConfirmation,
    confirm: confirmKeyboardPasteConfirmation
  } = useFileExplorerKeyboardPasteConfirmation(pasteToDirectory)

  const handlePaste = useCallback(
    (event: ClipboardEvent): void => {
      if (event.defaultPrevented || isEditableTarget(event.target)) {
        return
      }
      const root = rootRef.current
      if (!root || !worktreeId || !worktreePath || !displayRootPath) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      const destination = readFileExplorerPasteDir(root, event.target) ?? displayRootPath
      void readClipboardPastePreview().then((preview) => {
        if (preview) {
          requestKeyboardPasteConfirmation(destination)
        }
      })
    },
    [displayRootPath, requestKeyboardPasteConfirmation, worktreeId, worktreePath]
  )

  const resolveDropDir = (event: DragEvent): string | null => {
    // Hidden/search files views have no worktreePath.
    if (!worktreeId || !worktreePath || !displayRootPath) {
      return null
    }
    const dir = readFileExplorerDropDir(rootRef.current, event.target) ?? displayRootPath
    return getRelativePathInsideRoot(dir, displayRootPath) === null ? null : dir
  }

  const osFileDropOwnerRef = useOsFileDropOwner<FileExplorerDropDestination | null>(rootRef, {
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
        await importPreparedPaths(prepared.paths, destination)
      } catch (err) {
        toast.error(
          extractIpcErrorMessage(
            err,
            t(
              'auto.components.right.sidebar.useFileExplorerImport.importFailed',
              'Failed to import files.'
            )
          )
        )
      } finally {
        clearNativeDragState()
      }
    }
  })

  const pasteRootRef = useRef<HTMLElement | null>(null)
  const fileDropOwnerRef = useCallback(
    (root: HTMLElement | null) => {
      pasteRootRef.current?.removeEventListener('paste', handlePaste, true)
      pasteRootRef.current = root
      osFileDropOwnerRef(root)
      root?.addEventListener('paste', handlePaste, true)
    },
    [handlePaste, osFileDropOwnerRef]
  )

  return {
    fileDropOwnerRef,
    pasteToDirectory,
    keyboardPasteConfirmationOpen,
    cancelKeyboardPasteConfirmation,
    confirmKeyboardPasteConfirmation
  }
}
