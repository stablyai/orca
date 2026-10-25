import { describe, expect, it } from 'vitest'
import {
  encodeTerminalMenuSelectAllKitty,
  encodeTerminalSelectAllKittyKeyDown,
  shouldForwardSelectAllToKittyApp,
  withoutKittyLockModifiers
} from './terminal-kitty-select-all'

describe('terminal kitty select-all forwarding', () => {
  it('forwards only on macOS once the app negotiated kitty flags', () => {
    expect(shouldForwardSelectAllToKittyApp(true, 1)).toBe(true)
    expect(shouldForwardSelectAllToKittyApp(true, 0)).toBe(false)
    expect(shouldForwardSelectAllToKittyApp(false, 1)).toBe(false)
  })

  it('encodes the Edit-menu select-all as a Cmd+A tap', () => {
    expect(encodeTerminalMenuSelectAllKitty(1)).toBe('\x1b[97;9u')
    // Why: with event types the app also needs the release, or Super+A looks held.
    expect(encodeTerminalMenuSelectAllKitty(3)).toBe('\x1b[97;9u\x1b[97;9:3u')
  })
})

describe('select-all kitty encoding with a native-like KeyboardEvent', () => {
  /** Mimics a DOM KeyboardEvent: its fields are prototype getters an object spread drops. */
  class NativeLikeKeyEvent {
    private readonly locks: Record<string, boolean>
    constructor(locks: Record<string, boolean> = {}) {
      this.locks = locks
    }
    get key(): string {
      return 'a'
    }
    get code(): string {
      return 'KeyA'
    }
    get metaKey(): boolean {
      return true
    }
    get shiftKey(): boolean {
      return false
    }
    get altKey(): boolean {
      return false
    }
    get ctrlKey(): boolean {
      return false
    }
    get repeat(): boolean {
      return false
    }
    getModifierState(key: string): boolean {
      // Why: fails like the DOM method when called with a copied object as its receiver.
      if (!(this instanceof NativeLikeKeyEvent)) {
        throw new TypeError('Illegal invocation')
      }
      return this.locks[key] === true
    }
  }

  it('still encodes Cmd+A as Super+A, CapsLock on or off', () => {
    expect(withoutKittyLockModifiers(new NativeLikeKeyEvent()).key).toBe('a')
    expect(encodeTerminalSelectAllKittyKeyDown(new NativeLikeKeyEvent(), 1)).toBe('\x1b[97;9u')
    expect(encodeTerminalSelectAllKittyKeyDown(new NativeLikeKeyEvent({ CapsLock: true }), 1)).toBe(
      '\x1b[97;9u'
    )
  })
})
