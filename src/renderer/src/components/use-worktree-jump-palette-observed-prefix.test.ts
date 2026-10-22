// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { createPaletteSearchContext } from '@/lib/palette-match/palette-ranking'
import { buildWorkspaceTabBaseResult } from '@/lib/workspace-tab-palette-results'
import type { PaletteListEntry } from './worktree-jump-palette-model'
import { transcriptTab } from './cmd-j/palette-transcript-test-fixture'
import { useWorktreeJumpPaletteObservedPrefix } from './use-worktree-jump-palette-observed-prefix'

afterEach(cleanup)

function fixture() {
  const entries: PaletteListEntry[] = [
    {
      id: '__header_open_tabs__',
      type: 'section-header',
      section: 'open-tabs',
      label: 'Open Tabs'
    },
    ...Array.from({ length: 6 }, (_, index) => {
      const result = buildWorkspaceTabBaseResult(
        transcriptTab(String(index)),
        createPaletteSearchContext(1000)
      )
      return { id: result.paletteIdentity, type: 'workspace-tab' as const, result }
    })
  ]
  const list = document.createElement('div')
  list.getBoundingClientRect = () => new DOMRect(0, 0, 100, 80)
  Object.defineProperty(list, 'offsetHeight', { value: 80 })
  for (const [index, entry] of entries.entries()) {
    const node = document.createElement('div')
    node.dataset.paletteOccurrence = entry.id
    node.getBoundingClientRect = () => new DOMRect(0, index * 20, 100, 20)
    list.appendChild(node)
  }
  const listRef = { current: list }
  const hook = renderHook(
    ({ key }) => useWorktreeJumpPaletteObservedPrefix({ generationKey: key, listRef }),
    { initialProps: { key: 'query A' } }
  )
  act(() =>
    hook.result.current.commitPresentation(
      entries,
      entries.map((entry) => entry.id)
    )
  )
  return { ...hook, entries, list }
}

it('captures the committed visible prefix before updates and extends it only on actual keyboard navigation', () => {
  const { result, entries } = fixture()
  act(() => result.current.handlePresentationSelectionChange(entries[6].id))
  expect(result.current.protectedOccurrences).toEqual([])
  act(() => {
    result.current.handlePresentationKeyDown()
    result.current.handlePresentationSelectionChange(entries[1].id)
  })
  expect(result.current.protectedOccurrences.map((entry) => entry.id)).toEqual(
    entries.slice(0, 4).map((entry) => entry.id)
  )
  act(() => {
    result.current.handlePresentationKeyDown()
    result.current.handlePresentationSelectionChange(entries[6].id)
  })
  expect(result.current.protectedOccurrences).toHaveLength(7)
  expect(result.current.presentationHeight).toBe(80)
})

it('protects hover and real scroll without relying on cmdk selection callbacks', () => {
  const { result, list } = fixture()
  act(() => result.current.handlePresentationPointer(list.children[1]))
  expect(result.current.protectedOccurrences).toHaveLength(4)
  act(() => result.current.resetPresentation())
  act(() => result.current.handlePresentationScroll())
  expect(result.current.protectedOccurrences).toEqual([])
  act(() => result.current.handlePresentationWheel())
  expect(result.current.protectedOccurrences).toHaveLength(4)
})

it('preserves the surviving observed extent after a removal and an earlier hover', () => {
  const { result, entries, list } = fixture()
  act(() => {
    result.current.handlePresentationKeyDown()
    result.current.handlePresentationSelectionChange(entries[5].id)
  })
  expect(result.current.protectedOccurrences).toHaveLength(6)

  const remaining = entries.filter((entry) => entry !== entries[2])
  list.children[2].remove()
  act(() => {
    result.current.commitPresentation(
      remaining,
      remaining.map((entry) => entry.id)
    )
    result.current.handlePresentationPointer(list.children[1])
  })
  expect(result.current.protectedOccurrences.map((entry) => entry.id)).toEqual(
    remaining.slice(0, 5).map((entry) => entry.id)
  )

  act(() => {
    result.current.handlePresentationKeyDown()
    result.current.handlePresentationSelectionChange(entries[6].id)
  })
  expect(result.current.protectedOccurrences.map((entry) => entry.id)).toEqual(
    remaining.map((entry) => entry.id)
  )
})

it('ends keyboard observation before a later programmatic selection change', async () => {
  const { result, entries } = fixture()
  await act(async () => result.current.handlePresentationKeyDown())
  act(() => result.current.handlePresentationSelectionChange(entries[6].id))
  expect(result.current.protectedOccurrences).toHaveLength(4)
})

it('invalidates immediately and never revives a snapshot when a raw query/filter/policy/visibility key returns', () => {
  const { result, rerender, list } = fixture()
  act(() => result.current.handlePresentationPointer(list.children[1]))
  expect(result.current.presentationInteracted).toBe(true)
  rerender({ key: 'query B' })
  expect(result.current.protectedOccurrences).toEqual([])
  expect(result.current.presentationHeight).toBe(0)
  rerender({ key: 'query A' })
  expect(result.current.protectedOccurrences).toEqual([])
})

it('does not carry a scroll gesture into a new generation or explicit expansion', () => {
  const { result, rerender, entries } = fixture()
  act(() => result.current.handlePresentationWheel())
  rerender({ key: 'query B' })
  act(() => {
    result.current.commitPresentation(
      entries,
      entries.map((entry) => entry.id)
    )
    result.current.handlePresentationScroll()
  })
  expect(result.current.protectedOccurrences).toEqual([])
  rerender({ key: 'query A' })
  act(() => {
    result.current.commitPresentation(
      entries,
      entries.map((entry) => entry.id)
    )
    result.current.handlePresentationScroll()
  })
  expect(result.current.protectedOccurrences).toEqual([])

  act(() => result.current.handlePresentationWheel())
  act(() => result.current.resetPresentation())
  act(() => result.current.handlePresentationScroll())
  expect(result.current.protectedOccurrences).toEqual([])
})

it('ends scroll capture when the browser reports the gesture has finished', () => {
  const { result, entries, list } = fixture()
  act(() => result.current.handlePresentationWheel())
  expect(result.current.protectedOccurrences).toHaveLength(4)
  act(() => result.current.handlePresentationScrollEnd())
  list.getBoundingClientRect = () => new DOMRect(0, 40, 100, 80)
  act(() => result.current.handlePresentationScroll())
  expect(result.current.protectedOccurrences).toHaveLength(4)

  act(() => result.current.handlePresentationWheel())
  expect(result.current.protectedOccurrences.map((entry) => entry.id)).toEqual(
    entries.slice(0, 6).map((entry) => entry.id)
  )
})
