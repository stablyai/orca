import { it, expect } from 'vitest'

import {
  getEffectiveKeybindingsForDefinition as effective,
  getKeybindingDefinition
} from '../../../../shared/keybindings'
import { matchesNativeChatToggleShortcut } from './native-chat-shortcut'

it.each(['win32', 'linux'] as const)(
  'keeps the default chat toggle separate from the %s worktree palette',
  (platform) => {
    expect(matchesNativeChatToggleShortcut({ key: 'j', ctrlKey: true }, platform, {})).toBe(true)
    expect(
      matchesNativeChatToggleShortcut({ key: 'j', ctrlKey: true, shiftKey: true }, platform, {})
    ).toBe(false)
    const palette = getKeybindingDefinition('worktree.palette')
    if (!palette) {
      throw new Error('Missing worktree palette')
    }
    expect(effective(palette, platform, {})).toEqual(['Mod+Shift+J'])
    expect(
      matchesNativeChatToggleShortcut({ key: 'j', ctrlKey: true, shiftKey: true }, platform, {
        'worktree.palette': []
      })
    ).toBe(true)
    expect(
      matchesNativeChatToggleShortcut({ key: 'j', ctrlKey: true }, platform, {
        'terminal.toggleNativeChat': ['Mod+Alt+Y']
      })
    ).toBe(false)
  }
)

it('bounds warm saved-alias work and invalidates on snapshot replacement; dynamic definitions bypass memo', () => {
  const measure = (size: number) => {
    let reads = 0
    const aliases = Array.from({ length: size }, () => 'Mod+Shift+J')
    aliases.forEach((value, index) =>
      Object.defineProperty(aliases, index, { get: () => (reads++, value) })
    )
    const overrides = { 'worktree.navigateDown': aliases }
    const input = { key: 'j', metaKey: true, shiftKey: true }
    expect(matchesNativeChatToggleShortcut(input, 'darwin', overrides)).toBe(false)
    const cold = reads
    expect(cold).toBeGreaterThan(0)
    for (let i = 0; i < 100; i++) {
      matchesNativeChatToggleShortcut(input, 'darwin', overrides)
    }
    expect(reads).toBe(cold)
    expect(
      matchesNativeChatToggleShortcut(input, 'darwin', {
        ...overrides,
        'worktree.navigateDown': []
      })
    ).toBe(true)
    return cold
  }
  expect(measure(100)).toBe(10 * measure(10))
  const definition = getKeybindingDefinition('terminal.toggleNativeChat')
  if (!definition) {
    throw new Error('Missing toggle')
  }
  const overrides = { 'worktree.navigateDown': ['Mod+Shift+J'] }
  effective(definition, 'darwin', overrides)
  expect(
    effective(
      { ...definition, defaultBindings: { darwin: ['Mod+Alt+Y'], linux: [], win32: [] } },
      'darwin',
      overrides
    )
  ).toEqual(['Mod+Alt+Y'])
  expect(effective(definition, 'darwin', overrides, [definition])).toEqual(['Mod+Shift+J'])
})
