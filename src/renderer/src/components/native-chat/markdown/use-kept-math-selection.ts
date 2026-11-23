import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'

/** A selected equation, by its source and its place among the reply's equations with that source. */
type MathSelection = { source: string; index: number }

const MATH = '[data-math-source]'

function equationsWithSource(root: HTMLElement, source: string): Element[] {
  return [...root.querySelectorAll(MATH)].filter(
    (math) => math.getAttribute('data-math-source') === source
  )
}

function selectedEquation(root: HTMLElement): MathSelection | null {
  const selection = document.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return null
  }
  const container = selection.getRangeAt(0).commonAncestorContainer
  const within = container instanceof Element ? container : container.parentElement
  const math = within?.closest(MATH)
  const source = math?.getAttribute('data-math-source')
  if (!math || source == null || !root.contains(math)) {
    return null
  }
  return { source, index: equationsWithSource(root, source).indexOf(math) }
}

/** While a reply streams, a redraw can replace a typeset equation's element, and a selection in it
 *  would go with it: the replacement, the same source at the same place, is selected instead. */
export function useKeptMathSelection(root: RefObject<HTMLElement | null>, active: boolean): void {
  const kept = useRef<MathSelection | null>(null)
  useEffect(() => {
    if (!active) {
      kept.current = null
      return
    }
    const note = (): void => {
      kept.current = root.current ? selectedEquation(root.current) : null
    }
    note()
    document.addEventListener('selectionchange', note)
    return () => document.removeEventListener('selectionchange', note)
  }, [active, root])
  // Runs in the commit that replaced the element, before the browser reports the lost selection.
  useLayoutEffect(() => {
    const was = kept.current
    const element = root.current
    const selection = document.getSelection()
    if (!was || !element || !selection) {
      return
    }
    const range = selection.rangeCount > 0 ? selection.getRangeAt(0) : null
    if (range && !range.collapsed && range.commonAncestorContainer.isConnected) {
      return
    }
    const replacement = equationsWithSource(element, was.source)[was.index]
    if (!replacement) {
      return
    }
    const next = document.createRange()
    next.selectNodeContents(replacement)
    selection.removeAllRanges()
    selection.addRange(next)
  })
}
