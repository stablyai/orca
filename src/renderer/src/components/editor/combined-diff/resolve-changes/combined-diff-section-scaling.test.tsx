// @vitest-environment happy-dom

import type React from 'react'
import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Virtualizer } from '@tanstack/react-virtual'
import { createProgrammaticScrollMarks } from '@/hooks/programmatic-scroll-marks'
import type { VirtualizedScrollAnchor } from '@/hooks/useVirtualizedScrollAnchor'
import type { DiffSection } from '../../diff-section-types'
import { useCombinedDiffScrollAnchors } from '../scroll-viewport/use-combined-diff-scroll-anchors'
import { useCombinedDiffTreeNavigation } from '../browse-files/use-combined-diff-tree-navigation'
import { useCombinedDiffSectionIndexMap } from './use-combined-diff-section-index-map'
import { useCombinedDiffSectionRowKeys } from './use-combined-diff-section-row-keys'

const SECTION_COUNT = 500

type KeyReadCounter = { reads: number }

/**
 * Sections whose `key` getter counts reads. Every O(N)-per-load pass this PR targets derives from
 * `section.key`, so the read count is a direct, deterministic proxy for the quadratic work.
 */
function makeCountingSection(
  counter: KeyReadCounter,
  key: string,
  overrides: Partial<DiffSection> = {}
): DiffSection {
  const section: DiffSection = {
    key: '',
    path: key,
    status: 'modified',
    originalContent: '',
    modifiedContent: '',
    collapsed: false,
    loading: true,
    dirty: false,
    diffResult: null,
    largeDiffRenderLimit: null,
    ...overrides
  }
  Object.defineProperty(section, 'key', {
    configurable: true,
    enumerable: true,
    get: () => {
      counter.reads += 1
      return key
    }
  })
  return section
}

const FAKE_VIRTUALIZER = {
  getTotalSize: () => 0,
  getVirtualItems: () => [],
  isScrolling: false,
  measure: vi.fn(),
  scrollToIndex: vi.fn()
} as unknown as Virtualizer<HTMLDivElement, Element>

// Stable across renders so the hooks under test see the same dependency identities the viewer gives them.
const NO_DIRECT_SCROLL_INPUT = (): boolean => false
const NOOP = vi.fn()
const PROGRAMMATIC_SCROLL_MARKS = createProgrammaticScrollMarks()
const SCROLL_CONTAINER_REF = { current: null } as React.RefObject<HTMLDivElement | null>
const SCROLL_ANCHOR_REF = { current: null } as React.RefObject<VirtualizedScrollAnchor>
const LATEST_DOM_SCROLL_ANCHOR_REF = { current: null } as React.RefObject<VirtualizedScrollAnchor>
const SCROLL_OFFSET_REF = { current: 0 } as React.RefObject<number>

function useCombinedDiffSectionPasses({
  sections,
  sectionsRef
}: {
  sections: DiffSection[]
  sectionsRef: React.RefObject<DiffSection[]>
}): {
  allSectionsCollapsed: boolean
  rowKeys: readonly string[]
  sectionIndexByKey: ReadonlyMap<string, number>
  viewedSectionKeys: ReadonlySet<string>
} {
  const sectionRowKeys = useCombinedDiffSectionRowKeys({ generation: 1, sections })
  const sectionIndexByKey = useCombinedDiffSectionIndexMap({ entrySignature: 'sig', sections })
  const anchors = useCombinedDiffScrollAnchors({
    clampRestoreCount: 0,
    generation: 1,
    hasDirectScrollInput: NO_DIRECT_SCROLL_INPUT,
    latestDomScrollAnchorRef: LATEST_DOM_SCROLL_ANCHOR_REF,
    programmaticScrollMarks: PROGRAMMATIC_SCROLL_MARKS,
    scrollAnchorRef: SCROLL_ANCHOR_REF,
    scrollContainerRef: SCROLL_CONTAINER_REF,
    scrollOffsetRef: SCROLL_OFFSET_REF,
    sectionIndexByKey,
    sections,
    sectionsRef,
    sideBySide: false,
    structureRevision: sectionRowKeys.structureRevision,
    totalSize: 0,
    viewStateKey: 'scaling-test',
    virtualizer: FAKE_VIRTUALIZER
  })
  const treeNavigation = useCombinedDiffTreeNavigation({
    ensureSectionLoaded: NOOP,
    entrySignature: 'sig',
    markDirectScrollInput: NOOP,
    scrollToIndex: anchors.scrollToSectionIndex,
    sectionIndexByKey,
    sections,
    sectionsRef,
    toggleSection: NOOP,
    treeMode: 'all'
  })
  return {
    allSectionsCollapsed: sectionRowKeys.allSectionsCollapsed,
    rowKeys: sectionRowKeys.rowKeys,
    sectionIndexByKey,
    viewedSectionKeys: treeNavigation.viewedSectionKeys
  }
}

describe('combined diff section passes at scale', () => {
  it('stays O(N) in section-key reads across a full progressive load of 500 sections', () => {
    const counter: KeyReadCounter = { reads: 0 }
    const initial = Array.from({ length: SECTION_COUNT }, (_, index) =>
      makeCountingSection(counter, `combined-branch:file-${index}.ts`)
    )
    const sectionsRef = { current: initial } as React.RefObject<DiffSection[]>
    const view = renderHook(
      ({ sections }: { sections: DiffSection[] }) => {
        sectionsRef.current = sections
        return useCombinedDiffSectionPasses({ sections, sectionsRef })
      },
      { initialProps: { sections: initial } }
    )
    const firstRowKeys = view.result.current.rowKeys
    const firstIndexMap = view.result.current.sectionIndexByKey
    const readsAfterMount = counter.reads

    let sections = initial
    for (let index = 0; index < SECTION_COUNT; index += 1) {
      // Mirrors loadSectionNow's `prev.map((s, i) => i === index ? {...s, ...} : s)`: one new
      // section object, every other row keeps its identity.
      const next = sections.slice()
      next[index] = makeCountingSection(counter, `combined-branch:file-${index}.ts`, {
        loading: false,
        contentGeneration: 1
      })
      sections = next
      view.rerender({ sections })
    }

    const loadReads = counter.reads - readsAfterMount
    // O(N): a handful of reads per loaded section. The pre-fix passes (restore-signal join, a
    // second key -> index Map, the viewed-key key compare) read every key on every load, which is
    // ~3 * 500 * 500 reads here.
    expect(loadReads).toBeLessThanOrEqual(8 * SECTION_COUNT)

    // Outputs are still exactly right after the incremental patching.
    expect(view.result.current.rowKeys).toHaveLength(SECTION_COUNT)
    expect(view.result.current.rowKeys[0]).toBe('combined-branch:file-0.ts:expanded:1:1')
    expect(view.result.current.rowKeys[499]).toBe('combined-branch:file-499.ts:expanded:1:1')
    expect(view.result.current.rowKeys).not.toBe(firstRowKeys)
    expect(view.result.current.sectionIndexByKey).toBe(firstIndexMap)
    expect(view.result.current.sectionIndexByKey.get('combined-branch:file-250.ts')).toBe(250)
    expect(view.result.current.viewedSectionKeys.size).toBe(SECTION_COUNT)
    expect(view.result.current.allSectionsCollapsed).toBe(false)
  })

  it('reuses the row-key string of every section a load did not touch', () => {
    const counter: KeyReadCounter = { reads: 0 }
    const sections = Array.from({ length: 4 }, (_, index) =>
      makeCountingSection(counter, `combined-branch:file-${index}.ts`)
    )
    const sectionsRef = { current: sections } as React.RefObject<DiffSection[]>
    const view = renderHook(
      ({ rows }: { rows: DiffSection[] }) => {
        sectionsRef.current = rows
        return useCombinedDiffSectionPasses({ sections: rows, sectionsRef })
      },
      { initialProps: { rows: sections } }
    )
    const firstRowKeys = view.result.current.rowKeys

    const next = sections.slice()
    next[2] = makeCountingSection(counter, 'combined-branch:file-2.ts', {
      loading: false,
      contentGeneration: 1
    })
    view.rerender({ rows: next })

    const rowKeys = view.result.current.rowKeys
    for (const index of [0, 1, 3]) {
      expect(rowKeys[index]).toBe(firstRowKeys[index])
    }
    expect(rowKeys[2]).toBe('combined-branch:file-2.ts:expanded:1:1')
  })

  it('returns the identical row-key result when a rerender changes nothing', () => {
    const counter: KeyReadCounter = { reads: 0 }
    const sections = Array.from({ length: 8 }, (_, index) =>
      makeCountingSection(counter, `combined-branch:file-${index}.ts`)
    )
    const view = renderHook(
      ({ rows }: { rows: DiffSection[] }) =>
        useCombinedDiffSectionRowKeys({ generation: 1, sections: rows }),
      { initialProps: { rows: sections } }
    )
    const first = view.result.current

    // A fresh array whose elements are identical: the shape a no-op setSections produces.
    view.rerender({ rows: sections.slice() })

    expect(view.result.current).toBe(first)
  })
})
