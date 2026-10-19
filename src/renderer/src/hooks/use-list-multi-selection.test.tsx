// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useListMultiSelection, type ListMultiSelection } from './use-list-multi-selection'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

type Item = { key: string }
const getKey = (item: Item): string => item.key
const a = { key: 'a' }
const b = { key: 'b' }
const c = { key: 'c' }
const d = { key: 'd' }

let container: HTMLDivElement
let scope: HTMLDivElement
let outside: HTMLDivElement
let root: Root
let selection: ListMultiSelection<Item>
const getScope = (): Element | null => scope

function Probe({ items }: { items: readonly Item[] }): null {
  selection = useListMultiSelection({ items, getKey, getScope })
  return null
}

function render(items: readonly Item[]): void {
  act(() => root.render(<Probe items={items} />))
}

function gesture(modifiers: Partial<Record<'metaKey' | 'ctrlKey' | 'shiftKey', boolean>>) {
  return { metaKey: false, ctrlKey: false, shiftKey: false, ...modifiers }
}

function setPlatform(isMac: boolean): void {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
    isMac ? 'Mozilla/5.0 (Macintosh)' : 'Mozilla/5.0 (Windows NT 10.0)'
  )
}

beforeEach(() => {
  container = document.createElement('div')
  scope = document.createElement('div')
  outside = document.createElement('div')
  document.body.append(container, scope, outside)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  scope.remove()
  outside.remove()
  vi.restoreAllMocks()
})

describe('useListMultiSelection', () => {
  it.each([
    ['macOS', true, { metaKey: true }],
    ['Windows/Linux', false, { ctrlKey: true }]
  ])('toggles with the %s modifier without navigating', (_label, isMac, modifier) => {
    setPlatform(isMac)
    render([a, b, c])

    let navigate = true
    act(() => {
      navigate = !selection.updateSelectionForGesture(gesture(modifier), a)
    })
    act(() => selection.updateSelectionForGesture(gesture(modifier), c))

    expect(navigate).toBe(false)
    expect(selection.selectedItems).toEqual([a, c])
    act(() => selection.updateSelectionForGesture(gesture(modifier), a))
    expect(selection.selectedItems).toEqual([c])
  })

  it('treats the other platform modifier as a plain click', () => {
    setPlatform(true)
    render([a, b])
    act(() => selection.updateSelectionForGesture(gesture({ metaKey: true }), a))
    let navigate = false
    act(() => {
      navigate = !selection.updateSelectionForGesture(gesture({ ctrlKey: true }), b)
    })

    expect(navigate).toBe(true)
    expect(selection.selectedItems).toEqual([b])
  })

  it('replaces on plain click and selects ranges in render order from the anchor', () => {
    setPlatform(false)
    render([a, b, c, d])
    act(() => selection.updateSelectionForGesture(gesture({}), b))
    act(() => selection.updateSelectionForGesture(gesture({ shiftKey: true }), d))

    expect(selection.selectedItems).toEqual([b, c, d])
    act(() => selection.updateSelectionForGesture(gesture({ shiftKey: true }), a))
    expect(selection.selectedItems).toEqual([a, b])
  })

  it('prunes rows that stop rendering and falls back to a surviving anchor', () => {
    setPlatform(false)
    render([a, b, c, d])
    act(() => selection.updateSelectionForGesture(gesture({ ctrlKey: true }), b))
    act(() => selection.updateSelectionForGesture(gesture({ ctrlKey: true }), c))

    render([a, c, d])
    expect(selection.selectedKeys).toEqual(new Set(['c']))
    act(() => selection.updateSelectionForGesture(gesture({ shiftKey: true }), d))
    expect(selection.selectedItems).toEqual([c, d])
  })

  it('keeps a 2+ selection for a right-click inside it and resets for one outside it', () => {
    setPlatform(false)
    render([a, b, c])
    act(() => selection.updateSelectionForGesture(gesture({ ctrlKey: true }), a))
    act(() => selection.updateSelectionForGesture(gesture({ ctrlKey: true }), b))

    let targets: readonly Item[] = []
    act(() => {
      targets = selection.selectForContextMenu(b)
    })
    expect(targets).toEqual([a, b])
    expect(selection.selectedItems).toEqual([a, b])

    act(() => {
      targets = selection.selectForContextMenu(c)
    })
    expect(targets).toEqual([c])
    expect(selection.selectedItems).toEqual([c])
  })

  it('clears on a pointerdown outside the scope only', () => {
    setPlatform(false)
    render([a, b])
    act(() => selection.updateSelectionForGesture(gesture({ ctrlKey: true }), a))

    act(() => {
      scope.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    })
    expect(selection.selectedItems).toEqual([a])
    act(() => {
      outside.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    })
    expect(selection.selectedItems).toEqual([])
  })

  it('keeps array identities across rebuilds with the same order', () => {
    setPlatform(false)
    render([a, b])
    act(() => selection.updateSelectionForGesture(gesture({ ctrlKey: true }), a))
    const { visibleKeys, selectedItems, updateSelectionForGesture } = selection

    render([a, b])
    expect(selection.visibleKeys).toBe(visibleKeys)
    expect(selection.selectedItems).toBe(selectedItems)
    expect(selection.updateSelectionForGesture).toBe(updateSelectionForGesture)
  })
})
