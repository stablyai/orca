// @vitest-environment happy-dom
import { useLayoutEffect, useRef, useState } from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import type { GitDiffTextResult } from '../../../../../../shared/git-diff-compare-types'
import type { DiffSection } from '../../diff-section-types'
import { useDiffSectionHeights } from '../../diff-section-height-cache'
import { getDiffSectionBodyHeight } from '../../diff-section-layout'
import {
  getCombinedDiffExtent,
  publishCombinedDiffSectionGeometry
} from '../../combined-diff-extent-dom'
import { useCombinedDiffExtent } from '../../use-combined-diff-extent'
import { useCombinedDiffSectionLoadRegistry } from '../load-sections/combined-diff-section-load-registry'
import { useCombinedDiffSectionRowKeys } from '../resolve-changes/use-combined-diff-section-row-keys'
import { useCombinedDiffEntrySet } from '../resolve-changes/use-combined-diff-entry-set'
import { useCombinedDiffVirtualizer } from './use-combined-diff-virtualizer'

const fetch = vi.hoisted(() => vi.fn())
vi.mock('../load-sections/fetch-combined-diff-section', () => ({ fetchCombinedDiffSection: fetch }))
import { useCombinedDiffSectionLoader } from '../load-sections/use-combined-diff-section-loader'

const text = (count: number) => Array.from({ length: count }, (_, i) => `line ${i}`).join('\n')
const result = (count = 1000): GitDiffTextResult => ({
  kind: 'text',
  originalContent: text(count),
  modifiedContent: `${text(count)} changed`,
  originalIsBinary: false,
  modifiedIsBinary: false
})
const file: OpenFile = {
  id: 'reload',
  filePath: '/repo',
  relativePath: 'Changes',
  worktreeId: 'wt',
  isDirty: false,
  language: 'plaintext',
  mode: 'diff',
  diffSource: 'combined-uncommitted'
}
const entries = ['clip-0', 'clip-a', 'clip-b'].map((path) => ({
  path,
  area: 'unstaged' as const,
  status: 'modified' as const,
  added: 1000,
  removed: 1000
}))
const branchEntries = []
function section(path: string): DiffSection {
  return {
    key: `unstaged:${path}`,
    path,
    area: 'unstaged',
    status: 'modified',
    collapsed: false,
    loading: false,
    dirty: false,
    diffResult: result(),
    largeDiffRenderLimit: null,
    originalContent: text(1000),
    modifiedContent: text(1000),
    added: 1000,
    removed: 1000
  }
}
afterEach(() => {
  cleanup()
  document.body.replaceChildren()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

function fixture(chrome = 28) {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
  const viewport = document.createElement('div')
  viewport.getClientRects = () => Object.assign([new DOMRect(0, 0, 800, 700)], { item: () => null })
  viewport.dataset.combinedDiffViewport = ''
  const content = document.createElement('div')
  content.dataset.combinedDiffExtent = ''
  viewport.append(content)
  document.body.append(viewport)
  let top = 0
  const writes: number[] = []
  Object.defineProperties(viewport, {
    clientHeight: { get: () => 700 },
    offsetHeight: { get: () => 700 },
    clientWidth: { get: () => 800 },
    offsetWidth: { get: () => 800 },
    scrollHeight: { get: () => Math.max(700, Number.parseFloat(content.style.height) || 0) },
    scrollTop: {
      get: () => top,
      set: (next: number) => {
        top = Math.max(0, Math.min(next, viewport.scrollHeight - 700))
        writes.push(top)
        viewport.dispatchEvent(new Event('scroll'))
      }
    }
  })
  const hook = renderHook(() => {
    const [sections, setSections] = useState(() => entries.map((entry) => section(entry.path)))
    const [heights, setHeights, heightAuthority] = useDiffSectionHeights('reload-context', sections)
    const registry = useCombinedDiffSectionLoadRegistry(sections)
    const initialized = useRef(false)
    if (!initialized.current) {
      registry.loadedIndicesRef.current = new Set([0, 1, 2])
      initialized.current = true
    }
    const entrySet = useCombinedDiffEntrySet({
      file,
      gitStatusEntries: entries,
      liveBranchEntries: branchEntries,
      sectionsRef: registry.sectionsRef
    })
    const loader = useCombinedDiffSectionLoader({
      entrySet,
      file,
      generation: 0,
      registry,
      sectionCount: sections.length,
      setSectionHeights: setHeights,
      setSections
    })
    const keys = useCombinedDiffSectionRowKeys({ generation: 0, sections })
    const scrollRef = useRef(viewport)
    const offset = useRef(0)
    const virtualizer = useCombinedDiffVirtualizer({
      generation: 0,
      renderedIndicesRef: registry.renderedIndicesRef,
      rowKeys: keys.rowKeys,
      scrollContainerRef: scrollRef,
      scrollOffsetRef: offset,
      sectionHeights: heights,
      heightAuthority,
      sections,
      sideBySide: true
    })
    useCombinedDiffExtent(viewport, virtualizer, undefined, sections, 'reload-context')
    useLayoutEffect(() => {
      content.replaceChildren(
        ...virtualizer.getVirtualItems().map((item) => {
          const current = sections[item.index]!
          const row = document.createElement('div')
          row.dataset.combinedDiffSectionRow = ''
          row.dataset.index = String(item.index)
          row.dataset.file = current.key
          const body =
            getDiffSectionBodyHeight({
              measuredContentHeight: heights[item.index],
              originalContent: current.originalContent,
              modifiedContent: current.modifiedContent,
              changedLineCount: 2000,
              useIntrinsicImageHeight: false
            }) ?? 60
          row.style.height = `${body + chrome}px`
          row.style.top = `${item.start}px`
          row.getBoundingClientRect = () => new DOMRect(0, item.start - top, 800, body + chrome)
          Object.defineProperty(row, 'offsetHeight', { get: () => body + chrome })
          return row
        })
      )
    })
    return { sections, setSections, heights, setHeights, registry, loader, virtualizer }
  })
  const measure = () => {
    for (const row of content.querySelectorAll<HTMLElement>('[data-index]')) {
      const virtualizer = hook.result.current.virtualizer
      virtualizer.measureElement(row)
      const rect = row.getBoundingClientRect()
      // The browser supplies real heights asynchronously; the synchronous native measurement reuses estimates.
      const height = virtualizer.options.measureElement(
        row,
        {
          target: row,
          contentRect: rect,
          borderBoxSize: [{ blockSize: rect.height, inlineSize: rect.width }],
          contentBoxSize: [],
          devicePixelContentBoxSize: []
        },
        virtualizer
      )
      virtualizer.resizeItem(Number(row.dataset.index), height)
    }
  }
  act(() => {
    hook.result.current.setHeights({
      0: 2207 - 19 - chrome,
      1: 20090 - 19 - chrome,
      2: 20090 - 19 - chrome
    })
  })
  act(measure)
  const owner = getCombinedDiffExtent(viewport)
  act(() => {
    owner.navigate(21507)
  })
  act(measure)
  expect(hook.result.current.virtualizer.getVirtualItems().map((item) => item.index)).toContain(1)
  expect(owner.item(1)?.size).toBe(20090)
  writes.length = 0
  return {
    hook,
    viewport,
    content,
    owner,
    writes,
    measure,
    ready: (index: number, height: number, publishFirst = false) => {
      act(() => {
        hook.result.current.setHeights((prev) => ({ ...prev, [index]: height }))
      })
      const publish = () => {
        const row = content.querySelector<HTMLElement>(`[data-index="${index}"]`)
        if (row) {
          publishCombinedDiffSectionGeometry(row, hook.result.current.sections[index]!)
        }
      }
      if (publishFirst) {
        act(publish)
      }
      act(() => {
        hook.result.current.virtualizer.resizeItem(index, height + 19 + chrome)
      })
      act(measure)
      const row = content.querySelector<HTMLElement>(`[data-index="${index}"]`)
      if (row) {
        act(() => {
          publishCombinedDiffSectionGeometry(row, hook.result.current.sections[index]!)
        })
      }
    },
    reload: async (index: number, count: number) => {
      fetch.mockResolvedValueOnce(result(count))
      await act(async () => {
        hook.result.current.registry.loadedIndicesRef.current.delete(index)
        await hook.result.current.registry.loadSectionRef.current(index)
      })
    }
  }
}

it.each(
  [1000, 1010].flatMap((count) => [false, true].map((publishFirst) => ({ count, publishFirst })))
)(
  'keeps T7 through a $count-line rebind with publishFirst=$publishFirst',
  async ({ count, publishFirst }) => {
    const f = fixture()
    expect(f.viewport.scrollTop).toBe(21507)
    expect(f.owner.exportView().anchor).toMatchObject({ key: 'unstaged:clip-a', offset: 19300 })
    await f.reload(1, count)
    act(f.measure)
    expect(f.hook.result.current.sections[1]!.contentGeneration).toBe(1)
    expect(f.hook.result.current.virtualizer.getVirtualItems().map((item) => item.index)).toContain(
      1
    )
    expect(
      f.content.querySelector('[data-file="unstaged:clip-a"]')?.getAttribute('style')
    ).toContain('height: 20090px')
    expect(f.owner.item(1)?.size).toBe(20090)
    expect(f.viewport.scrollTop).toBe(21507)
    expect(f.writes).toEqual([])
    expect(f.owner.exportView().anchor).toMatchObject({ key: 'unstaged:clip-a', offset: 19300 })
    f.ready(1, 20043, publishFirst)
    expect(f.viewport.scrollTop).toBe(21507)
  }
)

it.each([0, 2])(
  'retains a reloaded neighbor %i until ready geometry remaps its start',
  async (index) => {
    const f = fixture()
    const before = f.viewport.scrollTop
    await f.reload(index, 1008)
    act(f.measure)
    expect(f.viewport.scrollTop).toBe(before)
    expect(f.writes).toEqual([])
    f.ready(index, (index === 0 ? 2160 : 20043) + 200)
    expect(f.viewport.scrollTop).toBe(before + (index === 0 ? 200 : 0))
    expect(f.owner.exportView().anchor).toMatchObject({ key: 'unstaged:clip-a', offset: 19300 })
  }
)

it('normalizes a ready shrink once, so later growth cannot resurrect the old point', async () => {
  const f = fixture()
  await f.reload(1, 900)
  f.ready(1, 18043)
  expect(f.viewport.scrollTop).toBe(20297)
  f.writes.length = 0
  f.ready(1, 21043)
  expect(f.viewport.scrollTop).toBe(20297)
  expect(f.writes).toEqual([])
})

it('lets input and explicit navigation replace the point while geometry remains retained', async () => {
  const f = fixture()
  await f.reload(1, 1001)
  act(() => {
    f.owner.input()
    f.viewport.scrollTop = 22000
    f.owner.scrolled()
  })
  const afterInput = f.owner.exportView()
  f.ready(1, 20043)
  expect(f.owner.exportView()).toEqual(afterInput)
  act(() => {
    f.owner.navigate(100)
  })
  f.ready(1, 22043)
  expect(f.viewport.scrollTop).toBe(100)
})

it('does not land a pending import on an equal retained height from the old generation', async () => {
  const f = fixture()
  await f.reload(1, 1000)
  const saved = { scrollTop: 123, anchor: { key: 'unstaged:clip-a', offset: 19300 } }
  act(() => f.owner.importView(saved))
  expect(f.owner.exportView()).toEqual(saved)
  expect(f.viewport.scrollTop).toBe(21507)
  f.ready(1, 20043)
  expect(f.owner.exportView().scrollTop).toBe(21507)
})

it('uses the measured header extent when rebind estimates differ from the real row chrome', async () => {
  const f = fixture(50)
  await f.reload(1, 1000)
  act(f.measure)
  expect(f.owner.item(1)?.size).toBe(20090)
  expect(f.viewport.scrollTop).toBe(21507)
  expect(f.writes).toEqual([])
  f.ready(1, 20021)
  expect(f.viewport.scrollTop).toBe(21507)
})
