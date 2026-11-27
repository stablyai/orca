// A one-line label that loses its middle, not its end, when it doesn't fit: measured, so the "…" sits
// right against both halves.
import React, { useLayoutEffect, useRef, useState } from 'react'
import { middleEllipsis } from './middle-ellipsis'

let measureContext: CanvasRenderingContext2D | null | undefined

function textWidth(text: string, font: string): number | null {
  measureContext ??= document.createElement('canvas').getContext('2d')
  if (!measureContext) {
    return null
  }
  measureContext.font = font
  return measureContext.measureText(text).width
}

export function MiddleEllipsisLabel({ text }: { text: string }): React.JSX.Element {
  const ref = useRef<HTMLSpanElement>(null)
  const [box, setBox] = useState<{ width: number; font: string } | null>(null)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) {
      return
    }
    const observer = new ResizeObserver(([entry]) => {
      const width = entry?.contentRect.width ?? 0
      setBox((previous) =>
        previous?.width === width ? previous : { width, font: getComputedStyle(element).font }
      )
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const shown =
    box === null || textWidth('', box.font) === null
      ? text
      : middleEllipsis(text, (candidate) => (textWidth(candidate, box.font) ?? 0) <= box.width)
  // Plain end truncation stays as the fallback until it is measured.
  return (
    <span ref={ref} className="block min-w-0 flex-1 truncate whitespace-pre">
      {shown}
    </span>
  )
}
