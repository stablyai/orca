import { describe, expect, it } from 'vitest'
import { getWindowedCommandNavigation } from './windowed-command-navigation'

const ids = ['a', 'b', 'c', 'd']

function key(
  keyName: string,
  modifiers: Partial<{ ctrlKey: boolean; metaKey: boolean; isComposing: boolean }> = {}
) {
  return {
    key: keyName,
    ctrlKey: modifiers.ctrlKey ?? false,
    metaKey: modifiers.metaKey ?? false,
    defaultPrevented: false,
    nativeEvent: { isComposing: modifiers.isComposing ?? false }
  }
}

describe('getWindowedCommandNavigation', () => {
  it('steps through the full list and stops at the ends', () => {
    expect(getWindowedCommandNavigation(key('ArrowDown'), ids, 'b')).toEqual({ targetId: 'c' })
    expect(getWindowedCommandNavigation(key('ArrowUp'), ids, 'b')).toEqual({ targetId: 'a' })
    expect(getWindowedCommandNavigation(key('ArrowDown'), ids, 'd')).toEqual({ targetId: null })
  })

  it('matches cmdk when nothing is highlighted: down goes first, up goes nowhere', () => {
    expect(getWindowedCommandNavigation(key('ArrowDown'), ids, null)).toEqual({ targetId: 'a' })
    expect(getWindowedCommandNavigation(key('ArrowUp'), ids, null)).toEqual({ targetId: null })
  })

  it('jumps to the ends with Home/End and Meta+Arrow', () => {
    expect(getWindowedCommandNavigation(key('End'), ids, 'a')).toEqual({ targetId: 'd' })
    expect(getWindowedCommandNavigation(key('Home'), ids, 'c')).toEqual({ targetId: 'a' })
    expect(getWindowedCommandNavigation(key('ArrowDown', { metaKey: true }), ids, 'a')).toEqual({
      targetId: 'd'
    })
    expect(getWindowedCommandNavigation(key('ArrowUp', { metaKey: true }), ids, 'c')).toEqual({
      targetId: 'a'
    })
  })

  it('treats Ctrl+N/J and Ctrl+P/K as movement, plain letters as typing', () => {
    expect(getWindowedCommandNavigation(key('n', { ctrlKey: true }), ids, 'a')).toEqual({
      targetId: 'b'
    })
    expect(getWindowedCommandNavigation(key('j', { ctrlKey: true }), ids, 'a')).toEqual({
      targetId: 'b'
    })
    expect(getWindowedCommandNavigation(key('p', { ctrlKey: true }), ids, 'c')).toEqual({
      targetId: 'b'
    })
    expect(getWindowedCommandNavigation(key('k', { ctrlKey: true }), ids, 'c')).toEqual({
      targetId: 'b'
    })
    expect(getWindowedCommandNavigation(key('n'), ids, 'a')).toBeNull()
  })

  it('leaves composition, handled and non-movement keys alone', () => {
    expect(
      getWindowedCommandNavigation(key('ArrowDown', { isComposing: true }), ids, 'a')
    ).toBeNull()
    expect(
      getWindowedCommandNavigation({ ...key('ArrowDown'), defaultPrevented: true }, ids, 'a')
    ).toBeNull()
    expect(getWindowedCommandNavigation(key('Enter'), ids, 'a')).toBeNull()
  })

  it('claims movement keys on an empty list without a target', () => {
    expect(getWindowedCommandNavigation(key('End'), [], null)).toEqual({ targetId: null })
    expect(getWindowedCommandNavigation(key('ArrowDown'), [], null)).toEqual({ targetId: null })
  })
})
