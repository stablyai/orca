import { useCallback, useRef, useState, type SetStateAction } from 'react'
import type { DiffSection } from '../diff-section-types'

export function useCombinedDiffSectionsState(initial: DiffSection[] = []) {
  const [sections, renderSections] = useState(initial)
  const sectionsRef = useRef(sections)
  const setSections = useCallback((update: SetStateAction<DiffSection[]>) => {
    const next = typeof update === 'function' ? update(sectionsRef.current) : update
    // Native editor events can reach Save before React commits their queued render.
    sectionsRef.current = next
    renderSections(next)
  }, [])
  return { sections, sectionsRef, setSections }
}
