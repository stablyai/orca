// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { KeybindingOverrides } from '../../../shared/keybindings'

const platformRef = vi.hoisted(() => ({ current: 'darwin' as NodeJS.Platform }))

vi.mock('../lib/keyboard/shortcut-platform', () => ({
  getShortcutPlatform: () => platformRef.current
}))

const { formatShortcutLabel } = await import('./useShortcutLabel')

// A fresh overrides object per test keeps each case on its own cache entry, exactly as a real edit does.
function overridesFor(binding: string): KeybindingOverrides {
  return { 'tab.close': [binding] }
}

describe('shortcut label memoization', () => {
  beforeEach(() => {
    platformRef.current = 'darwin'
  })

  it('keys the cache by platform so Mac and Windows glyphs never cross', () => {
    const overrides = overridesFor('Mod+Shift+K')
    expect(formatShortcutLabel('tab.close', overrides)).toBe('⌘⇧K')
    platformRef.current = 'win32'
    expect(formatShortcutLabel('tab.close', overrides)).toBe('Ctrl+⇧+K')
    platformRef.current = 'darwin'
    expect(formatShortcutLabel('tab.close', overrides)).toBe('⌘⇧K')
  })
})
