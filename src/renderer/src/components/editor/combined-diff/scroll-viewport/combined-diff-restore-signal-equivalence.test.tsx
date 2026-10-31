// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { Virtualizer } from '@tanstack/react-virtual'
import { createProgrammaticScrollMarks } from '@/hooks/programmatic-scroll-marks'
import type { VirtualizedScrollAnchor } from '@/hooks/useVirtualizedScrollAnchor'
import type { DiffSection } from '../../diff-section-types'
import {
  getCombinedDiffExtent,
  publishCombinedDiffMeasurements
} from '../../combined-diff-extent-dom'
import { useCombinedDiffExtent } from '../../use-combined-diff-extent'
import { useCombinedDiffScrollAnchors } from './use-combined-diff-scroll-anchors'

const section = (key: string): DiffSection => ({
  key,
  path: key,
  status: 'modified',
  originalContent: '',
  modifiedContent: '',
  collapsed: false,
  loading: false,
  dirty: false,
  diffResult: null,
  largeDiffRenderLimit: null
})

afterEach(() => {
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

it('keeps native Escape ownership through Changes structural rekeys and staged prefix measurements', () => {
  const viewport = document.createElement('div')
  const content = document.createElement('div')
  content.dataset.combinedDiffExtent = ''
  viewport.append(content)
  document.body.append(viewport)
  Object.defineProperty(viewport, 'clientHeight', { value: 803 })
  let sections = [section('clip-0'), section('clip-a')]
  let rowKeys = ['clip-0:expanded:1:10', 'clip-a:expanded:1:0']
  const virtualizer = new Virtualizer<HTMLDivElement, Element>({
    count: 2,
    getScrollElement: () => viewport,
    getItemKey: (index) => rowKeys[index] ?? index,
    estimateSize: (index) => (index === 0 ? 2190 : 20000),
    initialRect: { width: 800, height: 803 },
    observeElementRect: (_instance, callback) => {
      callback({ width: 800, height: 803 })
      return () => {}
    },
    observeElementOffset: (_instance, callback) => {
      callback(viewport.scrollTop, false)
      return () => {}
    },
    scrollToFn: vi.fn(),
    onChange: (instance) => publishCombinedDiffMeasurements(instance)
  })
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    }
  )
  const unmount = virtualizer._didMount()
  virtualizer._willUpdate()
  const anchorRef: { current: VirtualizedScrollAnchor } = {
    current: { key: 'clip-0', offset: 1547 }
  }
  const args = {
    restorationKey: 'view-one',
    clampRestoreCount: 0,
    generation: 1,
    hasDirectScrollInput: () => false,
    latestDomScrollAnchorRef: { current: null },
    programmaticScrollMarks: createProgrammaticScrollMarks(),
    scrollAnchorRef: anchorRef,
    scrollContainerRef: { current: viewport },
    scrollOffsetRef: { current: 1547 },
    sectionIndexByKey: new Map([
      ['clip-0', 0],
      ['clip-a', 1]
    ]),
    sections,
    sectionsRef: { current: sections },
    sideBySide: false,
    structureRevision: 1,
    totalSize: 22190,
    memoryLeaseRef: { current: null },
    virtualizer
  }
  const hook = renderHook(() => {
    useCombinedDiffExtent(args.scrollContainerRef, virtualizer, undefined, sections)
    return useCombinedDiffScrollAnchors(args)
  })
  const owner = getCombinedDiffExtent(viewport)
  expect(viewport.scrollTop).toBe(1547)
  const saved = owner.capture(1, 30)
  if (!saved) {
    throw new Error('Missing native saved item')
  }
  owner.navigate(11794)
  owner.restore(saved)
  expect(viewport.scrollTop).toBe(1547)
  const restores = vi.spyOn(owner, 'restore')
  const rekey = (version: number, height: number): void => {
    sections = [{ ...sections[0]!, contentGeneration: version }, sections[1]!]
    rowKeys = [`clip-0:expanded:1:${version}`, rowKeys[1]!]
    virtualizer.setOptions({
      ...virtualizer.options,
      getItemKey: (index) => rowKeys[index] ?? index
    })
    virtualizer.resizeItem(0, height)
    args.structureRevision += 1
    args.sections = sections
    args.sectionsRef.current = sections
    hook.rerender()
  }
  act(() => rekey(11, 1738))
  expect(viewport.scrollTop).toBe(1095)
  expect(restores).not.toHaveBeenCalled()
  act(() => virtualizer.resizeItem(0, 2273))
  expect(viewport.scrollTop).toBe(1630)
  act(() => rekey(12, 2390))
  expect(viewport.scrollTop).toBe(1747)
  expect(owner.capture(1, 30)?.gap).toBe(673)
  expect(restores).not.toHaveBeenCalled()
  const changeAnchorMount = (collapsed: boolean, version: number, height: number): void => {
    sections = [sections[0]!, { ...sections[1]!, collapsed, contentGeneration: version }]
    rowKeys = [rowKeys[0]!, `clip-a:${collapsed ? 'collapsed' : 'expanded'}:2:${version}`]
    virtualizer.setOptions({
      ...virtualizer.options,
      getItemKey: (index) => rowKeys[index] ?? index
    })
    virtualizer.resizeItem(1, height)
    args.sections = sections
    args.sectionsRef.current = sections
    args.structureRevision += 1
    hook.rerender()
  }
  act(() => changeAnchorMount(true, 1, 30))
  expect(viewport.scrollTop).toBe(1747)
  act(() => changeAnchorMount(false, 2, 20000))
  expect(viewport.scrollTop).toBe(1747)
  expect(owner.item(1)?.key).toBe('clip-a')
  expect(restores).not.toHaveBeenCalled()
  hook.unmount()
  unmount()
})
