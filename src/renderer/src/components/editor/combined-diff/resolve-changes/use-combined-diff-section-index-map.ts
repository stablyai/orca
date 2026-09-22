import { useLayoutEffect, useMemo, useRef } from 'react'
import { createCombinedDiffSectionIndexMap } from './combined-diff-section-identity'

type CombinedDiffSectionIndexCache = {
  entrySignature: string
  sections: readonly { key: string }[]
  map: Map<string, number>
}

/**
 * Section-key to section-index map that keeps its identity while the section keys do.
 *
 * On-demand section loads replace the sections array on every fetch, so a freshly built Map would
 * be a memo miss for every consumer — the file tree would re-render all of its rows continuously
 * while the user scrolls a large diff.
 */
export function useCombinedDiffSectionIndexMap({
  entrySignature,
  sections
}: {
  entrySignature: string
  sections: readonly { key: string }[]
}): Map<string, number> {
  const cacheRef = useRef<CombinedDiffSectionIndexCache | null>(null)
  const sectionIndexByKey = useMemo(() => {
    const previous = cacheRef.current
    // Section content/loading updates preserve entry order and keys. The entry signature usually
    // changes when the navigable structure changes, but compare keys as a guard for reused
    // signatures (and to keep this cache correct if a caller rebuilds sections).
    if (
      previous !== null &&
      previous.entrySignature === entrySignature &&
      previous.sections.length === sections.length &&
      // Why identity first: a section load rewrites one element of a `prev.map(...)` copy, so most
      // rows settle on a pointer compare instead of a string compare.
      sections.every(
        (section, index) =>
          previous.sections[index] === section || previous.sections[index]?.key === section.key
      )
    ) {
      return previous.map
    }
    return createCombinedDiffSectionIndexMap(sections)
  }, [entrySignature, sections])

  // Why a committed write and not a render-phase one: React can discard a render, and a cache
  // seeded from abandoned work would hand a later render a map for sections that never existed.
  // Layout, not passive, so a synchronous re-render inside the same commit still sees this cache.
  useLayoutEffect(() => {
    cacheRef.current = { entrySignature, sections, map: sectionIndexByKey }
  }, [entrySignature, sectionIndexByKey, sections])

  return sectionIndexByKey
}
