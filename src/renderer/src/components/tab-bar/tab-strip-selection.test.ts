import { describe, expect, it } from 'vitest'
import {
  reconcileTabStripSelection,
  resolveTabStripSelectionClick,
  type TabStripSelectionModifiers,
  type TabStripSelectionState
} from './tab-strip-selection'

const NONE: TabStripSelectionModifiers = { shiftKey: false, metaKey: false, ctrlKey: false }

function select(
  selection: TabStripSelectionState,
  clickedId: string,
  modifiers: Partial<TabStripSelectionModifiers>,
  isMac = true
): TabStripSelectionState {
  return resolveTabStripSelectionClick({
    visibleTabIds: ['a', 'b', 'c', 'd'],
    clickedId,
    activeId: 'b',
    selection,
    modifiers: { ...NONE, ...modifiers },
    isMac
  })
}

describe('resolveTabStripSelectionClick', () => {
  it('uses a plain click as a single-tab selection and anchor', () => {
    expect(select({ selectedIds: ['a', 'c'], anchorId: 'a' }, 'd', {})).toEqual({
      selectedIds: ['d'],
      anchorId: 'd'
    })
  })

  it('toggles individual tabs with Cmd on macOS', () => {
    const first = select({ selectedIds: ['b'], anchorId: 'b' }, 'd', { metaKey: true }, true)
    expect(first).toEqual({ selectedIds: ['b', 'd'], anchorId: 'd' })

    expect(select(first, 'b', { metaKey: true }, true)).toEqual({
      selectedIds: ['d'],
      anchorId: 'b'
    })
  })

  it('allows macOS Cmd to toggle off the last selected tab', () => {
    expect(select({ selectedIds: ['b'], anchorId: 'b' }, 'b', { metaKey: true }, true)).toEqual({
      selectedIds: [],
      anchorId: 'b'
    })
  })

  it('starts macOS Cmd multi-selection from the active tab when selection is empty', () => {
    expect(select({ selectedIds: [], anchorId: null }, 'd', { metaKey: true }, true)).toEqual({
      selectedIds: ['b', 'd'],
      anchorId: 'd'
    })
  })

  it('toggles individual tabs with Ctrl outside macOS', () => {
    expect(select({ selectedIds: ['b'], anchorId: 'b' }, 'a', { ctrlKey: true }, false)).toEqual({
      selectedIds: ['b', 'a'],
      anchorId: 'a'
    })
  })

  it('starts non-mac Ctrl multi-selection from the active tab when selection is empty', () => {
    expect(select({ selectedIds: [], anchorId: null }, 'd', { ctrlKey: true }, false)).toEqual({
      selectedIds: ['b', 'd'],
      anchorId: 'd'
    })
  })

  it('does not treat Ctrl as the macOS toggle modifier', () => {
    expect(select({ selectedIds: ['b'], anchorId: 'b' }, 'a', { ctrlKey: true }, true)).toEqual({
      selectedIds: ['a'],
      anchorId: 'a'
    })
  })

  it('selects a contiguous range with Shift from the current anchor', () => {
    expect(select({ selectedIds: ['b'], anchorId: 'b' }, 'd', { shiftKey: true })).toEqual({
      selectedIds: ['b', 'c', 'd'],
      anchorId: 'b'
    })
  })

  it('uses the active tab as the first Shift-click anchor', () => {
    expect(select({ selectedIds: [], anchorId: null }, 'd', { shiftKey: true })).toEqual({
      selectedIds: ['b', 'c', 'd'],
      anchorId: 'b'
    })
  })
})

describe('reconcileTabStripSelection', () => {
  it('drops selected and anchor ids that are no longer visible', () => {
    expect(
      reconcileTabStripSelection({ selectedIds: ['a', 'gone', 'c'], anchorId: 'gone' }, ['a', 'c'])
    ).toEqual({
      selectedIds: ['a', 'c'],
      anchorId: null
    })
  })
})
