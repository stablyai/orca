import { useLayoutEffect, useMemo, useRef } from 'react'
import type { DiffSection } from '../../diff-section-types'

export type CombinedDiffSectionRowKeys = {
  allSectionsCollapsed: boolean
  /** Virtualizer item key per section index, pre-built so `getItemKey` is an array read. */
  rowKeys: readonly string[]
  /**
   * Bumps only when a row key actually changes. Scroll-anchor restore gates on this constant-size
   * token instead of re-joining every section key on every section load.
   */
  structureRevision: number
}

type CombinedDiffSectionRowKeyCache = {
  collapsedCount: number
  generation: number
  sections: readonly DiffSection[]
  value: CombinedDiffSectionRowKeys
}

export function buildCombinedDiffSectionRowKey(section: DiffSection, generation: number): string {
  // Why: contentGeneration is per-section, so a single row's reload remounts only that row.
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

  // Why: a section load rewrites exactly one element of a `prev.map(...)` copy, so object
  // identity is a sound (and allocation-free) test for "this row's key cannot have moved".
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

/**
 * One incremental pass over `sections` feeding every consumer that needs per-row identity.
 *
 * On-demand section loads replace the sections array once per loaded file, so each independent
 * `sections.map(...).join()` / `every(...)` consumer turns opening a review into O(N^2) work and
 * O(N^2) transient strings. This scan patches index by index — an unchanged row costs one pointer
 * compare and no property read — and returns the previous result unchanged when no row key moved.
 */
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

  // Why a committed write and not a render-phase one: React can discard a render, and a cache
  // seeded from abandoned work would let a later render patch against sections that never existed.
  // Layout, not passive, so a synchronous re-render inside the same commit still sees this cache.
  useLayoutEffect(() => {
    cacheRef.current = cache
  }, [cache])

  return cache.value
}
