import { useCallback, useEffect, useRef, useState } from 'react'
import type React from 'react'

const STORAGE_KEY = 'orca.docker.treeWidth'
const DEFAULT_WIDTH = 288 // matches previous w-72
const MIN_WIDTH = 200
const MAX_WIDTH = 640

function clamp(n: number): number {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, n))
}

type UseDockerTreeResizeResult = {
  width: number
  isResizing: boolean
  onResizeStart: (event: React.PointerEvent<HTMLElement>) => void
}

export function useDockerTreeResize(): UseDockerTreeResizeResult {
  const [width, setWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem(STORAGE_KEY))
    return Number.isFinite(saved) && saved > 0 ? clamp(saved) : DEFAULT_WIDTH
  })
  const [isResizing, setIsResizing] = useState(false)

  const resizingRef = useRef(false)
  const startXRef = useRef(0)
  const startWidthRef = useRef(width)
  const draftWidthRef = useRef(width)
  const frameRef = useRef<number | null>(null)

  const resetDocumentStyles = useCallback(() => {
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  }, [])

  const publishDraftWidth = useCallback((nextWidth: number) => {
    const clamped = clamp(nextWidth)
    if (clamped === draftWidthRef.current) return
    draftWidthRef.current = clamped
    if (frameRef.current !== null) return
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null
      setWidth(draftWidthRef.current)
    })
  }, [])

  const commitDraftWidth = useCallback(() => {
    const clamped = clamp(draftWidthRef.current)
    setWidth(clamped)
    localStorage.setItem(STORAGE_KEY, String(clamped))
  }, [])

  const stopResize = useCallback(() => {
    if (!resizingRef.current) return
    resizingRef.current = false
    setIsResizing(false)
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current)
      frameRef.current = null
    }
    resetDocumentStyles()
    commitDraftWidth()
  }, [commitDraftWidth, resetDocumentStyles])

  const handlePointerMove = useCallback(
    (event: PointerEvent) => {
      if (!resizingRef.current) return
      publishDraftWidth(startWidthRef.current + event.clientX - startXRef.current)
    },
    [publishDraftWidth]
  )

  useEffect(() => {
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', stopResize)
    window.addEventListener('pointercancel', stopResize)
    window.addEventListener('blur', stopResize)

    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', stopResize)
      window.removeEventListener('pointercancel', stopResize)
      window.removeEventListener('blur', stopResize)
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current)
        frameRef.current = null
      }
      resizingRef.current = false
      resetDocumentStyles()
    }
  }, [handlePointerMove, resetDocumentStyles, stopResize])

  const onResizeStart = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    resizingRef.current = true
    setIsResizing(true)
    startXRef.current = event.clientX
    startWidthRef.current = draftWidthRef.current
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }, [])

  return { width, isResizing, onResizeStart }
}
