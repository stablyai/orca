import type { RefObject } from 'react'
import { useAppStore } from '@/store/index'
import { useFileExplorerImagePaste } from '../mutations/use-file-explorer-image-paste'
import type { FileExplorerImportParams } from '../mutations/use-file-explorer-import-operation'
import type { FileExplorerRowProjection } from './file-explorer-row-projection'
import type { TreeNode } from './file-explorer-types'
import { useFileExplorerPasteEvents } from './use-file-explorer-paste-events'

type ImagePasteSessionParams = FileExplorerImportParams & {
  selectedNode: TreeNode | null
  containerRef: RefObject<HTMLDivElement | null>
  rowProjection: FileExplorerRowProjection
  isEditing: boolean
}

/** Clipboard image paste plus the key and menu events that trigger it. */
export function useFileExplorerImagePasteSession({
  containerRef,
  rowProjection,
  selectedNode,
  isEditing,
  worktreeId,
  ...importParams
}: ImagePasteSessionParams) {
  const imagePaste = useFileExplorerImagePaste({
    ...importParams,
    worktreeId,
    selectedNode,
    revealPath: (path) => {
      if (worktreeId) {
        useAppStore.getState().revealInExplorer(worktreeId, path)
      }
    }
  })
  useFileExplorerPasteEvents({
    containerRef,
    rowProjection,
    selectedNode,
    isEditing,
    imagePaste
  })
  return imagePaste
}
