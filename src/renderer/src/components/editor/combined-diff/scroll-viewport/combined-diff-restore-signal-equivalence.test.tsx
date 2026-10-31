// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type { Virtualizer } from '@tanstack/react-virtual'
import { createProgrammaticScrollMarks } from '@/hooks/programmatic-scroll-marks'
import type { VirtualizedScrollAnchor } from '@/hooks/useVirtualizedScrollAnchor'
import type { DiffSection } from '../../diff-section-types'
import { getCombinedDiffExtent } from '../../combined-diff-extent-dom'
import { useCombinedDiffScrollAnchors } from './use-combined-diff-scroll-anchors'

it('restores through the logical owner once per structure, then maps late heights without a DOM retry', () => {
  const viewport = document.createElement('div')
  Object.defineProperty(viewport, 'clientHeight', { value: 700 })
  const measurements = (prefix: number) => [
    { key: 'a', index: 0, start: 0, end: prefix, size: prefix, lane: 0 },
    { key: 'b', index: 1, start: prefix, end: prefix + 20000, size: 20000, lane: 0 }
  ]
  let current = measurements(670)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this adapter fixture supplies the complete measurement interface used by the hook and owner.
  const virtualizer = {
    scrollElement: viewport,
    get measurementsCache() {
      return current
    },
    getTotalSize: () => current.at(-1)?.end ?? 0,
    getVirtualItems: () => current
  } as unknown as Virtualizer<HTMLDivElement, Element>
  const anchorRef = { current: { key: 'b', offset: 32 } as VirtualizedScrollAnchor }
  const args = {
    clampRestoreCount: 0,
    generation: 1,
    hasDirectScrollInput: () => false,
    latestDomScrollAnchorRef: { current: null },
    programmaticScrollMarks: createProgrammaticScrollMarks(),
    scrollAnchorRef: anchorRef,
    scrollContainerRef: { current: viewport },
    scrollOffsetRef: { current: 0 },
    sectionIndexByKey: new Map([
      ['a', 0],
      ['b', 1]
    ]),
    sections: new Array<DiffSection>(),
    sectionsRef: { current: new Array<DiffSection>() },
    sideBySide: false,
    structureRevision: 1,
    totalSize: 20670,
    memoryLeaseRef: { current: null },
    virtualizer
  }
  const hook = renderHook(() => useCombinedDiffScrollAnchors(args))
  expect(viewport.scrollTop).toBe(702)
  const owner = getCombinedDiffExtent(viewport)
  current = measurements(870)
  owner.publish(current)
  expect(viewport.scrollTop).toBe(902)
  hook.rerender()
  expect(viewport.scrollTop).toBe(902)
  hook.result.current.scrollToSectionIndex(0)
  expect(viewport.scrollTop).toBe(0)
  hook.unmount()
  vi.restoreAllMocks()
})
