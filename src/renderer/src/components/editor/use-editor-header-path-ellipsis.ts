import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { ellipsizePathStart } from './editor-header-path-ellipsis'

type EditorHeaderPathEllipsis = {
  /** Attach to the element that renders the path label. */
  pathRef: (node: HTMLElement | null) => void
  /** The label with leading segments dropped to fit the element's width. */
  displayLabel: string
}

/**
 * Measures candidates in a detached span cloned from the live element's
 * computed font, because reading the element's own width while rewriting its
 * text would feed each measurement back into the next one.
 */
function createMeasurer(element: HTMLElement): {
  measure: (text: string) => number
  dispose(): void
} {
  const probe = document.createElement('span')
  const { font, letterSpacing } = window.getComputedStyle(element)
  probe.style.position = 'absolute'
  probe.style.visibility = 'hidden'
  probe.style.whiteSpace = 'pre'
  probe.style.font = font
  probe.style.letterSpacing = letterSpacing
  document.body.append(probe)

  return {
    measure: (text: string): number => {
      probe.textContent = text
      return probe.getBoundingClientRect().width
    },
    dispose: (): void => probe.remove()
  }
}

export function useEditorHeaderPathEllipsis(label: string): EditorHeaderPathEllipsis {
  const nodeRef = useRef<HTMLElement | null>(null)
  const labelRef = useRef(label)
  const resizeObserverRef = useRef<ResizeObserver | null>(null)
  const removeResizeListenerRef = useRef<(() => void) | null>(null)
  const [displayLabel, setDisplayLabel] = useState(label)

  labelRef.current = label

  const measureLabel = useCallback((element: HTMLElement | null) => {
    const fullLabel = labelRef.current
    if (!element || typeof window.getComputedStyle !== 'function') {
      setDisplayLabel(fullLabel)
      return
    }

    const measurer = createMeasurer(element)
    try {
      const next = ellipsizePathStart(fullLabel, element.clientWidth, measurer.measure)
      setDisplayLabel((current) => (current === next ? current : next))
    } finally {
      measurer.dispose()
    }
  }, [])

  const pathRef = useCallback(
    (node: HTMLElement | null): void => {
      resizeObserverRef.current?.disconnect()
      resizeObserverRef.current = null
      removeResizeListenerRef.current?.()
      removeResizeListenerRef.current = null

      nodeRef.current = node
      if (!node) {
        return
      }

      measureLabel(node)
      const remeasure = (): void => measureLabel(node)
      if (typeof ResizeObserver === 'undefined') {
        window.addEventListener('resize', remeasure)
        removeResizeListenerRef.current = () => window.removeEventListener('resize', remeasure)
        return
      }

      const observer = new ResizeObserver(remeasure)
      observer.observe(node)
      resizeObserverRef.current = observer
    },
    [measureLabel]
  )

  // Why: ResizeObserver does not fire when only the path text changes.
  useLayoutEffect(() => {
    measureLabel(nodeRef.current)
  }, [measureLabel, label])

  return { pathRef, displayLabel }
}
