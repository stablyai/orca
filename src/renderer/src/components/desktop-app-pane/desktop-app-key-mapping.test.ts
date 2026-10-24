import { describe, expect, it } from 'vitest'
import { mapKeyEventToDesktopAppInput, type DesktopAppKeyEvent } from './desktop-app-key-mapping'

function key(overrides: Partial<DesktopAppKeyEvent>): DesktopAppKeyEvent {
  return {
    key: 'a',
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    isComposing: false,
    ...overrides
  }
}

describe('desktop app key mapping', () => {
  it('sends printable characters as text', () => {
    expect(mapKeyEventToDesktopAppInput(key({ key: 'ç' }))).toEqual({ kind: 'text', text: 'ç' })
    expect(mapKeyEventToDesktopAppInput(key({ key: 'A', shiftKey: true }))).toEqual({
      kind: 'text',
      text: 'A'
    })
  })

  it('maps named keys to the computer-use grammar', () => {
    expect(mapKeyEventToDesktopAppInput(key({ key: 'Enter' }))).toEqual({
      kind: 'key',
      key: 'return'
    })
    expect(mapKeyEventToDesktopAppInput(key({ key: 'Tab', shiftKey: true }))).toEqual({
      kind: 'key',
      key: 'shift+tab'
    })
  })

  it('forwards editing shortcuts and leaves Orca shortcuts alone', () => {
    expect(mapKeyEventToDesktopAppInput(key({ key: 'a', metaKey: true }))).toEqual({
      kind: 'key',
      key: 'cmd+a'
    })
    expect(mapKeyEventToDesktopAppInput(key({ key: 't', metaKey: true }))).toBeNull()
    expect(mapKeyEventToDesktopAppInput(key({ key: 'Meta', metaKey: true }))).toBeNull()
  })

  it('uses Ctrl as the primary modifier off Mac', () => {
    const map = (overrides: Partial<DesktopAppKeyEvent>) =>
      mapKeyEventToDesktopAppInput(key(overrides), false)
    expect(map({ key: 'c', ctrlKey: true })).toEqual({ kind: 'key', key: 'ctrl+c' })
    expect(map({ key: 'Z', ctrlKey: true, shiftKey: true })).toEqual({
      kind: 'key',
      key: 'ctrl+shift+z'
    })
    expect(map({ key: 't', ctrlKey: true })).toBeNull()
    expect(map({ key: 'v', ctrlKey: true })).toBeNull()
    expect(map({ key: 'Tab', ctrlKey: true })).toBeNull()
    expect(map({ key: 'ArrowLeft', ctrlKey: true })).toEqual({ kind: 'key', key: 'ctrl+left' })
    expect(map({ key: 'a', metaKey: true })).toBeNull()
  })

  it('keeps AltGr characters as text and Alt letters as chords off Mac', () => {
    const map = (overrides: Partial<DesktopAppKeyEvent>) =>
      mapKeyEventToDesktopAppInput(key(overrides), false)
    expect(map({ key: '@', ctrlKey: true, altKey: true })).toEqual({ kind: 'text', text: '@' })
    expect(map({ key: 'f', altKey: true })).toEqual({ kind: 'key', key: 'alt+f' })
    expect(map({ key: 'é' })).toEqual({ kind: 'text', text: 'é' })
    expect(map({ key: 'Enter' })).toEqual({ kind: 'key', key: 'return' })
  })

  it('still forwards Ctrl chords to the app on Mac', () => {
    expect(mapKeyEventToDesktopAppInput(key({ key: 'e', ctrlKey: true }))).toEqual({
      kind: 'key',
      key: 'ctrl+e'
    })
  })
})
