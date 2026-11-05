import { useLayoutEffect, useMemo, useRef } from 'react'
import { createCombinedDiffSectionIndexMap } from './combined-diff-section-identity'

type CombinedDiffSectionIndexCache = {
  entrySignature: string
  sections: readonly { key: string }[]
  map: Map<string, number>
}

/** Preserve map identity while section keys match so progressive loads do not rerender every tree row. */
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
    // Content loads keep keys/order; verify keys too because callers may reuse signatures while rebuilding sections.
    if (
      previous !== null &&
      previous.entrySignature === entrySignature &&
      previous.sections.length === sections.length &&
      // Identity settles untouched load siblings without reading their keys.
      sections.every(
        (section, index) =>
          previous.sections[index] === section || previous.sections[index]?.key === section.key
      )
    ) {
      return previous.map
    }
    return createCombinedDiffSectionIndexMap(sections)
  }, [entrySignature, sections])

  // Cache only committed sections; abandoned renders must not seed later lookups. Layout timing supports same-commit rerenders.
  useLayoutEffect(() => {
    cacheRef.current = { entrySignature, sections, map: sectionIndexByKey }
  }, [entrySignature, sectionIndexByKey, sections])

  return sectionIndexByKey
}
