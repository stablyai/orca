import { describe, expect, it } from 'vitest'
import {
  findAutomationListSelectionIndex,
  getAutomationListArrowNavigationTarget,
  isAutomationListArrowKey,
  shouldHandleAutomationListSearchArrowKey
} from './automation-list-keyboard-navigation'

const items = [
  { id: 'local-1', kind: 'local' as const },
  { id: 'local-2', kind: 'local' as const },
  { id: 'ext-1', kind: 'external' as const }
]

describe('isAutomationListArrowKey', () => {
  it('accepts only unmodified ArrowUp/ArrowDown names', () => {
    expect(isAutomationListArrowKey('ArrowDown')).toBe(true)
    expect(isAutomationListArrowKey('ArrowUp')).toBe(true)
    expect(isAutomationListArrowKey('ArrowLeft')).toBe(false)
    expect(isAutomationListArrowKey('Enter')).toBe(false)
  })
})

describe('shouldHandleAutomationListSearchArrowKey', () => {
  function event(
    overrides: Partial<{
      key: string
      altKey: boolean
      ctrlKey: boolean
      metaKey: boolean
      shiftKey: boolean
      isComposing: boolean
    }> = {}
  ) {
    return {
      key: 'ArrowDown',
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      nativeEvent: { isComposing: overrides.isComposing ?? false },
      ...overrides
    }
  }

  it('handles plain ArrowUp/ArrowDown', () => {
    expect(shouldHandleAutomationListSearchArrowKey(event())).toBe(true)
    expect(shouldHandleAutomationListSearchArrowKey(event({ key: 'ArrowUp' }))).toBe(true)
  })

  it('ignores composing, modified, and non-arrow keys', () => {
    expect(shouldHandleAutomationListSearchArrowKey(event({ isComposing: true }))).toBe(false)
    expect(shouldHandleAutomationListSearchArrowKey(event({ metaKey: true }))).toBe(false)
    expect(shouldHandleAutomationListSearchArrowKey(event({ ctrlKey: true }))).toBe(false)
    expect(shouldHandleAutomationListSearchArrowKey(event({ altKey: true }))).toBe(false)
    expect(shouldHandleAutomationListSearchArrowKey(event({ shiftKey: true }))).toBe(false)
    expect(shouldHandleAutomationListSearchArrowKey(event({ key: 'Escape' }))).toBe(false)
  })
})

describe('findAutomationListSelectionIndex', () => {
  it('prefers the external key when one is set', () => {
    expect(findAutomationListSelectionIndex(items, 'local-1', 'ext-1')).toBe(2)
  })

  it('finds the local row when no external key is set', () => {
    expect(findAutomationListSelectionIndex(items, 'local-2', null)).toBe(1)
  })

  it('returns -1 when nothing in the visible list is selected', () => {
    expect(findAutomationListSelectionIndex(items, 'missing', null)).toBe(-1)
    expect(findAutomationListSelectionIndex(items, null, null)).toBe(-1)
  })
})

describe('getAutomationListArrowNavigationTarget', () => {
  it('returns null when the list is empty', () => {
    expect(
      getAutomationListArrowNavigationTarget({
        items: [],
        selectedId: null,
        selectedExternalKey: null,
        key: 'ArrowDown'
      })
    ).toBeNull()
  })

  it('selects the first row on ArrowDown and the last on ArrowUp when nothing is selected', () => {
    expect(
      getAutomationListArrowNavigationTarget({
        items,
        selectedId: null,
        selectedExternalKey: null,
        key: 'ArrowDown'
      })
    ).toEqual(items[0])
    expect(
      getAutomationListArrowNavigationTarget({
        items,
        selectedId: null,
        selectedExternalKey: null,
        key: 'ArrowUp'
      })
    ).toEqual(items[2])
  })

  it('steps to the next and previous visible rows, including across local/external', () => {
    expect(
      getAutomationListArrowNavigationTarget({
        items,
        selectedId: 'local-1',
        selectedExternalKey: null,
        key: 'ArrowDown'
      })
    ).toEqual(items[1])
    expect(
      getAutomationListArrowNavigationTarget({
        items,
        selectedId: 'local-2',
        selectedExternalKey: null,
        key: 'ArrowDown'
      })
    ).toEqual(items[2])
    expect(
      getAutomationListArrowNavigationTarget({
        items,
        selectedId: null,
        selectedExternalKey: 'ext-1',
        key: 'ArrowUp'
      })
    ).toEqual(items[1])
  })

  it('clamps at the ends instead of wrapping', () => {
    expect(
      getAutomationListArrowNavigationTarget({
        items,
        selectedId: 'local-1',
        selectedExternalKey: null,
        key: 'ArrowUp'
      })
    ).toEqual(items[0])
    expect(
      getAutomationListArrowNavigationTarget({
        items,
        selectedId: null,
        selectedExternalKey: 'ext-1',
        key: 'ArrowDown'
      })
    ).toEqual(items[2])
  })
})
