import { useEffect, useRef, useState } from 'react'

/** Expanded state for the notes list, which the palette's note count can open and focus. */
export function useAnnotationTrayReveal(revealSignal: number): {
  expanded: boolean
  setExpanded: (expanded: boolean) => void
  headerRef: React.RefObject<HTMLButtonElement | null>
} {
  const [expanded, setExpanded] = useState(true)
  const headerRef = useRef<HTMLButtonElement>(null)
  // The palette's note count asks for the list: expand during render, then move focus once it is painted.
  const [seenRevealSignal, setSeenRevealSignal] = useState(revealSignal)
  if (revealSignal !== seenRevealSignal) {
    setSeenRevealSignal(revealSignal)
    setExpanded(true)
  }
  useEffect(() => {
    if (revealSignal !== 0) {
      headerRef.current?.focus()
    }
  }, [revealSignal])
  return { expanded, setExpanded, headerRef }
}
