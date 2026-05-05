import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('useModifierHint helpers', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  it('starts the timer only for the bare platform modifier', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Macintosh' })
    const { shouldStartModifierHintTimer } = await import('./useModifierHint')

    expect(
      shouldStartModifierHintTimer({
        key: 'Meta',
        altKey: false,
        shiftKey: false,
        ctrlKey: false,
        metaKey: true,
        repeat: false
      } as KeyboardEvent)
    ).toBe(true)

    expect(
      shouldStartModifierHintTimer({
        key: 'Meta',
        altKey: false,
        shiftKey: true,
        ctrlKey: false,
        metaKey: true,
        repeat: false
      } as KeyboardEvent)
    ).toBe(false)

    expect(
      shouldStartModifierHintTimer({
        key: 'b',
        altKey: false,
        shiftKey: false,
        ctrlKey: false,
        metaKey: true,
        repeat: false
      } as KeyboardEvent)
    ).toBe(false)
  })

  it('clears when the shortcut key is released while the modifier is still held', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Macintosh' })
    const { shouldClearModifierHintOnKeyUp } = await import('./useModifierHint')

    expect(
      shouldClearModifierHintOnKeyUp({
        key: 'b',
        ctrlKey: false,
        metaKey: true
      } as KeyboardEvent)
    ).toBe(true)

    expect(
      shouldClearModifierHintOnKeyUp({
        key: 'Meta',
        ctrlKey: false,
        metaKey: false
      } as KeyboardEvent)
    ).toBe(true)

    expect(
      shouldClearModifierHintOnKeyUp({
        key: 'b',
        ctrlKey: false,
        metaKey: false
      } as KeyboardEvent)
    ).toBe(false)
  })

  it('detects whether the platform modifier is held per OS', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Macintosh' })
    const mac = await import('./useModifierHint')
    expect(mac.isPlatformModifierHeld({ metaKey: true, ctrlKey: false })).toBe(true)
    expect(mac.isPlatformModifierHeld({ metaKey: false, ctrlKey: true })).toBe(false)
    expect(mac.isPlatformModifierHeld({ metaKey: false, ctrlKey: false })).toBe(false)

    vi.resetModules()
    vi.stubGlobal('navigator', { userAgent: 'Windows NT 10.0' })
    const win = await import('./useModifierHint')
    expect(win.isPlatformModifierHeld({ metaKey: false, ctrlKey: true })).toBe(true)
    expect(win.isPlatformModifierHeld({ metaKey: true, ctrlKey: false })).toBe(false)
    expect(win.isPlatformModifierHeld({ metaKey: false, ctrlKey: false })).toBe(false)
  })
})
