import { describe, expect, it } from 'vitest'
import {
  getRemoteBrowserKeypressKey,
  getRemoteBrowserKeyboardShortcut
} from './remote-browser-keyboard'

function keyboardEvent(
  overrides: Partial<Parameters<typeof getRemoteBrowserKeyboardShortcut>[0]>
): Parameters<typeof getRemoteBrowserKeyboardShortcut>[0] {
  return {
    key: 'r',
    code: 'KeyR',
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...overrides
  }
}

describe('remote browser keyboard serialization', () => {
  it('serializes modified letter shortcuts', () => {
    expect(getRemoteBrowserKeyboardShortcut(keyboardEvent({ ctrlKey: true }))).toBe('Control+r')
  })

  it('preserves Shift on modified letter shortcuts', () => {
    expect(
      getRemoteBrowserKeyboardShortcut(keyboardEvent({ key: 'R', ctrlKey: true, shiftKey: true }))
    ).toBe('Control+Shift+r')
  })

  it('keeps plain shifted printable input as text input', () => {
    const event = keyboardEvent({ key: 'R', shiftKey: true })

    expect(getRemoteBrowserKeyboardShortcut(event)).toBeNull()
    expect(getRemoteBrowserKeypressKey(event)).toBe('R')
  })
})
