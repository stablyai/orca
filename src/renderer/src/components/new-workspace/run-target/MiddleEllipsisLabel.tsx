// A one-line label that loses its middle, not its end, when it doesn't fit: measured, so the "…" sits
// right against both halves.
import React, { useLayoutEffect, useRef, useState } from 'react'
import { middleEllipsis } from './middle-ellipsis'

let measureContext: CanvasRenderingContext2D | null | undefined

type TextStyle = { font: string; letterSpacing: number }

function textWidth(text: string, style: TextStyle): number | null {
  measureContext ??= document.createElement('canvas').getContext('2d')
  if (!measureContext) {
    return null
  }
  measureContext.font = style.font
  // Why: the canvas ignores CSS letter-spacing, which the DOM adds after every character.
  return measureContext.measureText(text).width + Array.from(text).length * style.letterSpacing
}

export function MiddleEllipsisLabel({ text }: { text: string }): React.JSX.Element {
  const ref = useRef<HTMLSpanElement>(null)
  const [box, setBox] = useState<({ width: number } & TextStyle) | null>(null)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) {
      return
    }
    const observer = new ResizeObserver(([entry]) => {
      const width = entry?.contentRect.width ?? 0
      setBox((previous) => {
        if (previous?.width === width) {
          return previous
        }
        const style = getComputedStyle(element)
        return {
          width,
          font: style.font,
          letterSpacing: Number.parseFloat(style.letterSpacing) || 0
        }
      })
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const shown =
    box === null || textWidth('', box) === null
      ? text
      : middleEllipsis(text, (candidate) => (textWidth(candidate, box) ?? 0) <= box.width)
  // Plain end truncation stays as the fallback until it is measured.
  return (
    <span ref={ref} className="block min-w-0 flex-1 truncate whitespace-pre">
      {shown}
    </span>
  )
}
