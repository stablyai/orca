import { useCallback } from 'react'
import type { DragEventHandler } from 'react'
import {
  getWorkspaceFileDragRejectionMessage,
  readWorkspaceFileDragPaths,
  WORKSPACE_FILE_PATHS_MIME,
  WORKSPACE_FILE_PATH_MIME
} from '@/lib/workspace-file-drag'

type UseNativeChatWorkspaceDropArgs = {
  disabled: boolean
  insertTypedText: (text: string) => boolean
  setNotice: (notice: string | null) => void
}

function hasWorkspaceFileDragData(types: readonly string[]): boolean {
  return types.includes(WORKSPACE_FILE_PATH_MIME) || types.includes(WORKSPACE_FILE_PATHS_MIME)
}

export function useNativeChatWorkspaceDrop({
  disabled,
  insertTypedText,
  setNotice
}: UseNativeChatWorkspaceDropArgs): {
  onDragOver: DragEventHandler<HTMLDivElement>
  onDrop: DragEventHandler<HTMLDivElement>
} {
  const onDragOver = useCallback<DragEventHandler<HTMLDivElement>>(
    (event) => {
      if (disabled || !hasWorkspaceFileDragData(event.dataTransfer.types)) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      event.dataTransfer.dropEffect = 'copy'
    },
    [disabled]
  )

  const onDrop = useCallback<DragEventHandler<HTMLDivElement>>(
    (event) => {
      if (disabled || !hasWorkspaceFileDragData(event.dataTransfer.types)) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      const result = readWorkspaceFileDragPaths(event.dataTransfer)
      if (result.status === 'rejected') {
        setNotice(getWorkspaceFileDragRejectionMessage(result.reason))
        return
      }
      if (result.paths.length === 0) {
        return
      }
      if (insertTypedText(result.paths.join('\n'))) {
        setNotice(null)
      }
    },
    [disabled, insertTypedText, setNotice]
  )

  return { onDragOver, onDrop }
}
