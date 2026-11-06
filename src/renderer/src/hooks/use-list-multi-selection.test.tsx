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
})
