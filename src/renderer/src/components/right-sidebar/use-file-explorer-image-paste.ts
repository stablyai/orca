import { useLayoutEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { dirname, getRelativePathInsideRoot } from '@/lib/path'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import type { ClipboardImageImport } from '../../../../shared/clipboard-image-import'
import type { TreeNode } from './file-explorer-types'
import { recordFileExplorerImagePaste } from './file-explorer-image-paste-history'
import {
  useFileExplorerImportOperation,
  type FileExplorerImportParams
} from './use-file-explorer-import-operation'

type FileExplorerImagePasteParams = FileExplorerImportParams & {
  selectedNode: TreeNode | null
}

export function useFileExplorerImagePaste(params: FileExplorerImagePasteParams) {
  const { worktreeId, worktreePath, displayRootPath = worktreePath, selectedNode } = params
  const { captureDestination, importPaths, isDestinationShown } =
    useFileExplorerImportOperation(params)
  const busyRef = useRef(false)
  const mountedRef = useRef(false)
  const [isPastingImage, setIsPastingImage] = useState(false)
  useLayoutEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const stage = window.api.ui.stageClipboardImageForImport
  const release = window.api.ui.releaseClipboardImageImport
  const canPasteImage = Boolean(
    stage && release && worktreeId && worktreePath && displayRootPath && !isPastingImage
  )

  // Passing null explicitly targets the background menu's displayed root.
  async function pasteImage(node: TreeNode | null = selectedNode): Promise<void> {
    if (
      !mountedRef.current ||
      !canPasteImage ||
      !stage ||
      !release ||
      busyRef.current ||
      !displayRootPath
    ) {
      return
    }
    if (node && getRelativePathInsideRoot(node.path, displayRootPath) === null) {
      return
    }
    const destinationDir = node
      ? node.isDirectory
        ? node.path
        : dirname(node.path)
      : displayRootPath
    let staged: ClipboardImageImport | null = null
    let retainedForUndo = false
    busyRef.current = true
    setIsPastingImage(true)
    try {
      const destination = captureDestination(
        destinationDir,
        node ? (node.operationOwner ?? { kind: 'unresolved' }) : params.operationOwner
      )
      if (!destination) {
        return
      }
      staged = await stage()
      if (staged) {
        const snapshot = staged
        await importPaths(destination, [snapshot.path], {
          requireExistingDestination: true,
          onImported: (importedPath) => {
            if (!isDestinationShown(destination)) {
              return
            }
            recordFileExplorerImagePaste({
              destination,
              snapshot,
              importedPath,
              importPaths,
              release,
              refreshAfterUndo: async () => {
                if (isDestinationShown(destination)) {
                  await params.refreshDir(destinationDir)
                }
                if (isDestinationShown(destination)) {
                  params.setSelectedPath(destinationDir)
                }
              }
            })
            retainedForUndo = true
          }
        })
      }
    } catch (error) {
      toast.error(extractIpcErrorMessage(error, 'Failed to import files.'))
    } finally {
      try {
        if (staged && !retainedForUndo) {
          await release(staged.handle)
        }
      } catch (error) {
        // The main-process lifecycle will retry cleanup without undoing a completed import.
        console.error('Failed to release clipboard image import:', error)
      } finally {
        busyRef.current = false
        if (mountedRef.current) {
          setIsPastingImage(false)
        }
      }
    }
  }

  return { canPasteImage, isPastingImage, pasteImage }
}
