import { describe, expect, it } from 'vitest'
import { resolveTabStripSelection, type TabStripActivationModifiers } from './tab-strip-selection'

const PLAIN: TabStripActivationModifiers = { metaKey: false, ctrlKey: false, shiftKey: false }
const DEFAULTS = {
  visibleTabIds: ['a', 'b', 'c', 'd'],
  activeTabId: 'b',
  selection: null,
  clickedTabId: 'd',
  modifiers: PLAIN,
  isMac: true
}

describe('tab strip highlight selection', () => {
  it('seeds the first modifier toggle with the active tab without activating', () => {
    expect(
      resolveTabStripSelection({ ...DEFAULTS, modifiers: { ...PLAIN, metaKey: true } })
    ).toEqual({
      activate: false,
      selection: { tabIds: ['b', 'd'], anchorTabId: 'd' }
    })
  })

  it('removes a highlighted tab and preserves the remaining highlights', () => {
    expect(
      resolveTabStripSelection({
        ...DEFAULTS,
        selection: { tabIds: ['a', 'b', 'd'], anchorTabId: 'a' },
        modifiers: { ...PLAIN, metaKey: true }
      })
    ).toEqual({ activate: false, selection: { tabIds: ['a', 'b'], anchorTabId: 'd' } })
  })

  it('lets the active tab itself be toggled out of the initial selection', () => {
    expect(
      resolveTabStripSelection({
        ...DEFAULTS,
        clickedTabId: 'b',
        modifiers: { ...PLAIN, metaKey: true }
      })
    ).toEqual({
      activate: false,
      selection: { tabIds: [], anchorTabId: 'b' }
    })
  })

  it('uses Ctrl, rather than Command, on non-Mac platforms', () => {
    expect(
      resolveTabStripSelection({
        ...DEFAULTS,
        isMac: false,
        modifiers: { ...PLAIN, ctrlKey: true }
      }).activate
    ).toBe(false)
    expect(
      resolveTabStripSelection({
        ...DEFAULTS,
        isMac: false,
        modifiers: { ...PLAIN, metaKey: true }
      }).activate
    ).toBe(true)
    expect(
      resolveTabStripSelection({ ...DEFAULTS, modifiers: { ...PLAIN, ctrlKey: true } }).activate
    ).toBe(true)
  })

  it('ranges in either direction from the highlight anchor rather than the active tab', () => {
    expect(
      resolveTabStripSelection({
        ...DEFAULTS,
        clickedTabId: 'a',
        selection: { tabIds: ['c'], anchorTabId: 'c' },
        modifiers: { ...PLAIN, shiftKey: true }
      })
    ).toEqual({ activate: false, selection: { tabIds: ['a', 'b', 'c'], anchorTabId: 'c' } })
  })

  it('skips hidden members of a collapsed cluster when selecting a visible range', () => {
    expect(
      resolveTabStripSelection({
        ...DEFAULTS,
        visibleTabIds: ['a', 'c', 'd'],
        activeTabId: 'a',
        modifiers: { ...PLAIN, shiftKey: true }
      })
    ).toEqual({ activate: false, selection: { tabIds: ['a', 'c', 'd'], anchorTabId: 'a' } })
  })

  it('falls back to the active tab when the previous range anchor is hidden', () => {
    expect(
      resolveTabStripSelection({
        ...DEFAULTS,
        visibleTabIds: ['a', 'c', 'd'],
        activeTabId: 'c',
        selection: { tabIds: ['b', 'c'], anchorTabId: 'b' },
        modifiers: { ...PLAIN, shiftKey: true }
      })
    ).toEqual({ activate: false, selection: { tabIds: ['c', 'd'], anchorTabId: 'c' } })
  })

  it('clears highlights and activates on a plain click', () => {
    expect(
      resolveTabStripSelection({ ...DEFAULTS, selection: { tabIds: ['a', 'b'], anchorTabId: 'a' } })
    ).toEqual({
      activate: true,
      selection: null
    })
  })

  it('selects just the clicked tab when no active or visible anchor exists', () => {
    expect(
      resolveTabStripSelection({
        ...DEFAULTS,
        activeTabId: null,
        modifiers: { ...PLAIN, shiftKey: true }
      })
    ).toEqual({
      activate: false,
      selection: { tabIds: ['d'], anchorTabId: 'd' }
    })
  })
})
