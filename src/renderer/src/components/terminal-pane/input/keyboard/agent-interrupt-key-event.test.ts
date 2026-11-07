import { describe, expect, it } from 'vitest'
import { isCtrlCKeyEvent, isPlainEscapeKeyEvent } from './agent-interrupt-key-event'

function keyEvent(overrides: Partial<KeyboardEvent>): Parameters<typeof isPlainEscapeKeyEvent>[0] {
  return {
    key: '',
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    ...overrides
  }
}

describe('agent interrupt key events', () => {
  it('requires exact plain Escape and Ctrl+C key events', () => {
    expect(isPlainEscapeKeyEvent(keyEvent({ key: 'Escape' }))).toBe(true)
    expect(isCtrlCKeyEvent(keyEvent({ key: 'c', ctrlKey: true }))).toBe(true)
    expect(isCtrlCKeyEvent(keyEvent({ key: 'C', ctrlKey: true }))).toBe(true)
    for (const event of [
      keyEvent({ key: 'Escape', altKey: true }),
      keyEvent({ key: 'Escape', shiftKey: true }),
      keyEvent({ key: 'Escape', repeat: true }),
      keyEvent({ key: 'c', ctrlKey: true, metaKey: true }),
      keyEvent({ key: 'c', ctrlKey: true, repeat: true })
    ]) {
      expect(isPlainEscapeKeyEvent(event) || isCtrlCKeyEvent(event)).toBe(false)
    }
  })
})
