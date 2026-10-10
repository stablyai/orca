import React, { useCallback, useEffect, useRef, useState } from 'react'
import { hasNativeFileDragTypes } from '../../../../shared/native-file-drop'
import { OS_FILE_DROP_OWNER_ATTRIBUTE } from '../../../../shared/native-file-drop-preparation'
import { extractImageFilesFromDataTransfer } from '@/lib/feedback-image-attachments'

type FeedbackImageDragHandlers = {
  onDragEnter: (event: React.DragEvent<HTMLElement>) => void
  onDragOver: (event: React.DragEvent<HTMLElement>) => void
  onDragLeave: (event: React.DragEvent<HTMLElement>) => void
}

export type FeedbackImageDrop = {
  isDragActive: boolean
  contentRef: (node: HTMLDivElement | null) => void
  dragHandlers: FeedbackImageDragHandlers
}

export function useFeedbackImageDrop(
  open: boolean,
  onAddFiles: (files: readonly File[]) => void
): FeedbackImageDrop {
  const [isDragActive, setIsDragActive] = useState(false)
  const detachRef = useRef<(() => void) | null>(null)
  const dragDepthRef = useRef(0)

  const reset = useCallback(() => {
    dragDepthRef.current = 0
    setIsDragActive(false)
  }, [])

  // Why: DataTransfer.files is empty until the drop lands, so the highlight has
  // to key off the drag types the OS advertises during the drag itself.
  const onDragEnter = useCallback((event: React.DragEvent<HTMLElement>) => {
    if (!hasNativeFileDragTypes(event.dataTransfer.types)) {
      return
    }
    dragDepthRef.current += 1
    setIsDragActive(true)
  }, [])

  // Why: the web client has no preload to preventDefault dragover for it, and
  // without that the browser refuses the drop and navigates to the dropped file.
  const onDragOver = useCallback((event: React.DragEvent<HTMLElement>) => {
    if (!hasNativeFileDragTypes(event.dataTransfer.types)) {
      return
    }
    event.preventDefault()
    // Keep accepted web drags from reaching the unclaimed-file guard.
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'copy'
  }, [])

  const onDragLeave = useCallback((event: React.DragEvent<HTMLElement>) => {
    // Why: mirror the enter guard so internal drags can't decrement a counter
    // enter never incremented.
    if (!hasNativeFileDragTypes(event.dataTransfer.types)) {
      return
    }
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    if (dragDepthRef.current === 0) {
      setIsDragActive(false)
    }
  }, [])

  const contentRef = useCallback(
    (node: HTMLDivElement | null): void => {
      detachRef.current?.()
      detachRef.current = null
      if (!node || !open) {
        return
      }
      const handleDrop = (event: DragEvent): void => {
        if (!hasNativeFileDragTypes(event.dataTransfer?.types)) {
          return
        }
        event.preventDefault()
        event.stopPropagation()
        reset()
        if (!event.isTrusted) {
          return
        }
        const images = extractImageFilesFromDataTransfer(event.dataTransfer)
        if (images.length > 0) {
          onAddFiles(images)
        }
      }
      node.setAttribute(OS_FILE_DROP_OWNER_ATTRIBUTE, '')
      node.addEventListener('drop', handleDrop, true)
      detachRef.current = () => {
        node.removeEventListener('drop', handleDrop, true)
        node.removeAttribute(OS_FILE_DROP_OWNER_ATTRIBUTE)
      }
    },
    [onAddFiles, open, reset]
  )
  useEffect(() => {
    if (!open) {
      reset()
      return
    }
    document.addEventListener('drop', reset, true)
    document.addEventListener('dragend', reset, true)
    return () => {
      document.removeEventListener('drop', reset, true)
      document.removeEventListener('dragend', reset, true)
      reset()
    }
  }, [open, reset])

  return { isDragActive, contentRef, dragHandlers: { onDragEnter, onDragOver, onDragLeave } }
}
