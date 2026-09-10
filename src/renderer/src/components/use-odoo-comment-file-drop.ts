import React, { useCallback, useEffect, useRef, useState } from 'react'
import { hasNativeFileDragTypes } from '../../../shared/native-file-drop'

type OdooCommentFileDragHandlers = {
  onDragEnter: (event: React.DragEvent<HTMLElement>) => void
  onDragOver: (event: React.DragEvent<HTMLElement>) => void
  onDragLeave: (event: React.DragEvent<HTMLElement>) => void
}

export type OdooCommentFileDrop = {
  isDragActive: boolean
  contentRef: React.RefObject<HTMLDivElement | null>
  dragHandlers: OdooCommentFileDragHandlers
}

/**
 * Drag-and-drop attachment wiring for the comment composer. Mirrors
 * useFeedbackImageDrop: preload consumes native OS file drops on `document`
 * capture before React ever sees them, so this claims the drop one phase
 * earlier on `window` and stops it from also reaching preload's native-drop lane.
 */
export function useOdooCommentFileDrop(
  active: boolean,
  onAddFiles: (files: readonly File[]) => void
): OdooCommentFileDrop {
  const [isDragActive, setIsDragActive] = useState(false)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const dragDepthRef = useRef(0)

  const reset = useCallback(() => {
    dragDepthRef.current = 0
    setIsDragActive(false)
  }, [])

  const onDragEnter = useCallback((event: React.DragEvent<HTMLElement>) => {
    if (!hasNativeFileDragTypes(event.dataTransfer.types)) {
      return
    }
    dragDepthRef.current += 1
    setIsDragActive(true)
  }, [])

  const onDragOver = useCallback((event: React.DragEvent<HTMLElement>) => {
    if (!hasNativeFileDragTypes(event.dataTransfer.types)) {
      return
    }
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }, [])

  const onDragLeave = useCallback((event: React.DragEvent<HTMLElement>) => {
    if (!hasNativeFileDragTypes(event.dataTransfer.types)) {
      return
    }
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    if (dragDepthRef.current === 0) {
      setIsDragActive(false)
    }
  }, [])

  useEffect(() => {
    if (!active) {
      return
    }
    const handleDrop = (event: DragEvent): void => {
      const droppedInComposer = contentRef.current?.contains(event.target as Node) ?? false
      reset()
      if (!droppedInComposer || !hasNativeFileDragTypes(event.dataTransfer?.types)) {
        return
      }
      event.preventDefault()
      const files = Array.from(event.dataTransfer?.files ?? [])
      if (files.length === 0) {
        return
      }
      event.stopPropagation()
      onAddFiles(files)
    }
    window.addEventListener('drop', handleDrop, true)
    window.addEventListener('dragend', reset, true)
    return () => {
      window.removeEventListener('drop', handleDrop, true)
      window.removeEventListener('dragend', reset, true)
      reset()
    }
  }, [onAddFiles, active, reset])

  return { isDragActive, contentRef, dragHandlers: { onDragEnter, onDragOver, onDragLeave } }
}
