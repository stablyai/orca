import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  isTerminalLinkActionActivation,
  isTerminalLinkDirectActivation,
  isTerminalOwnedLinkGesture
} from './terminal-link-activation'

function event(overrides: Partial<MouseEvent> = {}): MouseEvent {
  return {
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides
  } as MouseEvent
}

afterEach(() => vi.unstubAllGlobals())

describe('terminal link activation', () => {
  it('uses plain click for actions and Command-click for direct open on macOS', () => {
    vi.stubGlobal('navigator', { userAgent: 'Macintosh' })

    expect(isTerminalLinkActionActivation(event())).toBe(true)
    expect(isTerminalLinkDirectActivation(event({ metaKey: true }))).toBe(true)
    expect(isTerminalOwnedLinkGesture(event())).toBe(true)
  })

  it('reserves macOS Control-click for the context menu', () => {
    vi.stubGlobal('navigator', { userAgent: 'Macintosh' })

    expect(isTerminalLinkActionActivation(event({ ctrlKey: true }))).toBe(false)
    expect(isTerminalLinkDirectActivation(event({ ctrlKey: true }))).toBe(false)
  })

  it('uses Ctrl-click for direct open on Windows and Linux', () => {
    vi.stubGlobal('navigator', { userAgent: 'Windows' })

    expect(isTerminalLinkActionActivation(event())).toBe(true)
    expect(isTerminalLinkDirectActivation(event({ ctrlKey: true }))).toBe(true)
    expect(isTerminalLinkDirectActivation(event({ metaKey: true }))).toBe(false)
  })

  it('leaves Shift-only, Alt, and non-primary gestures unowned', () => {
    vi.stubGlobal('navigator', { userAgent: 'Macintosh' })

    expect(isTerminalOwnedLinkGesture(event({ shiftKey: true }))).toBe(false)
    expect(isTerminalOwnedLinkGesture(event({ altKey: true }))).toBe(false)
    expect(isTerminalOwnedLinkGesture(event({ button: 2 }))).toBe(false)
    expect(isTerminalLinkDirectActivation(event({ metaKey: true, shiftKey: true }))).toBe(true)
  })
})
