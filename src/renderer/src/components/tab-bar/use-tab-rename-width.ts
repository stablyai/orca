import { useCallback, useRef, useState, type CSSProperties } from 'react'

export function useTabRenameWidth(isEditing: boolean) {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState<number>()
  const captureWidth = useCallback(() => {
    setWidth(Math.max(240, ref.current?.getBoundingClientRect().width ?? 0))
  }, [])
  // Reserve usable editing space, then keep typing from resizing the strip.
  const style: CSSProperties | undefined = isEditing ? { width, flex: 'none' } : undefined
  return { ref, style, captureWidth }
}
