import { useLayoutEffect, useMemo, useRef } from 'react'
import type { DiffSection } from '../../diff-section-types'

export type CombinedDiffSectionRowKeys = {
  allSectionsCollapsed: boolean
  /** Virtualizer item key per section index, pre-built so `getItemKey` is an array read. */
  rowKeys: readonly string[]
  /** Constant-size restore token that changes only with row keys, avoiding full key joins per load. */
  structureRevision: number
}

type CombinedDiffSectionRowKeyCache = {
  collapsedCount: number
  generation: number
  sections: readonly DiffSection[]
  value: CombinedDiffSectionRowKeys
}

export function buildCombinedDiffSectionRowKey(section: DiffSection, generation: number): string {
  // Per-section content generations remount only the row whose content changed.
  return `${section.key}:${section.collapsed ? 'collapsed' : 'expanded'}:${generation}:${section.contentGeneration ?? 0}`
}

const EMPTY_ROW_KEYS: CombinedDiffSectionRowKeys = {
  allSectionsCollapsed: true,
  rowKeys: [],
  structureRevision: 0
}

function scanCombinedDiffSectionRowKeys(
  previous: CombinedDiffSectionRowKeyCache | null,
  generation: number,
  sections: readonly DiffSection[]
): CombinedDiffSectionRowKeyCache {
  if (previous !== null && previous.sections === sections && previous.generation === generation) {
    return previous
  }
  if (sections.length === 0) {
    const value = previous?.value.rowKeys.length === 0 ? previous.value : EMPTY_ROW_KEYS
    return { collapsedCount: 0, generation, sections, value }
  }

  // Loads replace one section, so sibling identity proves their row keys are unchanged without allocation.
  const patchable =
    previous !== null &&
    previous.generation === generation &&
    previous.value.rowKeys.length === sections.length
  const previousCache = patchable ? previous! : null
  const previousRowKeys = previousCache?.value.rowKeys ?? null
  const rowKeys: string[] = Array.from({ length: sections.length })
  let collapsedCount = previousCache?.collapsedCount ?? 0
  let changed = previousCache === null
  for (let index = 0; index < sections.length; index += 1) {
    const section = sections[index]!
    if (previousCache !== null && previousCache.sections[index] === section) {
      rowKeys[index] = previousRowKeys![index]!
      continue
    }
    if (previousCache?.sections[index]?.collapsed === true) {
      collapsedCount -= 1
    }
    if (section.collapsed) {
      collapsedCount += 1
    }
    const rowKey = buildCombinedDiffSectionRowKey(section, generation)
    rowKeys[index] = rowKey
    if (rowKey !== previousRowKeys?.[index]) {
      changed = true
    }
  }

  if (!changed && previousCache !== null) {
    return { collapsedCount, generation, sections, value: previousCache.value }
  }
  return {
    collapsedCount,
    generation,
    sections,
    value: {
      allSectionsCollapsed: collapsedCount === sections.length,
      rowKeys,
      structureRevision: (previous?.value.structureRevision ?? 0) + 1
    }
  }
}

/** Share incremental row-key derivation across consumers; untouched rows need only pointer comparisons, avoiding quadratic scans and transient strings. */
export function useCombinedDiffSectionRowKeys({
  generation,
  sections
}: {
  generation: number
  sections: readonly DiffSection[]
}): CombinedDiffSectionRowKeys {
  const cacheRef = useRef<CombinedDiffSectionRowKeyCache | null>(null)
  const cache = useMemo(
    () => scanCombinedDiffSectionRowKeys(cacheRef.current, generation, sections),
    [generation, sections]
  )

  // Cache only committed sections; abandoned renders must not seed later patches. Layout timing supports same-commit rerenders.
  useLayoutEffect(() => {
    cacheRef.current = cache
  }, [cache])

  return cache.value
}
