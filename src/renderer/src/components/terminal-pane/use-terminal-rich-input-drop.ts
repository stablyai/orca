import { useCallback, useEffect, useState } from 'react'
import { getWorkspaceFileDragPaths } from '@/lib/workspace-file-drag'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager'
import {
  TERMINAL_RICH_INPUT_NATIVE_DROP_EVENT,
  type TerminalRichInputNativeDropDetail
} from './terminal-rich-input-native-drop'

export function useTerminalRichInputDrop({
  open,
  pane,
  insertPaths
}: {
  open: boolean
  pane: ManagedPane
  insertPaths: (paths: string[]) => void
}): {
  busy: boolean
  imagePending: boolean
  onDragOver: (event: React.DragEvent) => void
  onDrop: (event: React.DragEvent) => void
} {
  const [nativeDrop, setNativeDrop] = useState({ count: 0, imagePending: false })
  useEffect(() => {
    if (open) {
      pane.container.dataset.terminalRichInputOpen = ''
    } else {
      delete pane.container.dataset.terminalRichInputOpen
    }
    return () => {
      delete pane.container.dataset.terminalRichInputOpen
    }
  }, [open, pane])

  useEffect(() => {
    const onNativeDrop = (event: Event): void => {
      const detail = (event as CustomEvent<TerminalRichInputNativeDropDetail>).detail
      if (detail?.phase === 'start') {
        setNativeDrop((current) => ({
          count: current.count + 1,
          imagePending: current.imagePending || detail.imagePending
        }))
      } else if (detail?.phase === 'resolved' && detail.paths.length > 0) {
        insertPaths(detail.paths)
      } else if (detail?.phase === 'end') {
        setNativeDrop((current) => {
          const count = Math.max(0, current.count - 1)
          return { count, imagePending: count > 0 && current.imagePending }
        })
      }
    }
    pane.container.addEventListener(TERMINAL_RICH_INPUT_NATIVE_DROP_EVENT, onNativeDrop)
    return () =>
      pane.container.removeEventListener(TERMINAL_RICH_INPUT_NATIVE_DROP_EVENT, onNativeDrop)
  }, [insertPaths, pane])

  const onDragOver = useCallback((event: React.DragEvent) => {
    if (getWorkspaceFileDragPaths(event.dataTransfer).length > 0) {
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
    }
  }, [])

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      const paths = getWorkspaceFileDragPaths(event.dataTransfer)
      if (paths.length === 0) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      insertPaths(paths)
    },
    [insertPaths]
  )

  return {
    busy: nativeDrop.count > 0,
    imagePending: nativeDrop.imagePending,
    onDragOver,
    onDrop
  }
}
