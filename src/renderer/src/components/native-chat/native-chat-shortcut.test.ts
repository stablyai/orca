import { describe, it, expect } from 'vitest'
import {
  getEffectiveKeybindingsForDefinition as effective,
  getKeybindingDefinition
} from '../../../../shared/keybindings'
import { matchesNativeChatToggleShortcut } from './native-chat-shortcut'

type Combo = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>

function combo(overrides: Partial<Combo>): Combo {
  return { key: 'j', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...overrides }
}

describe('matchesNativeChatToggleShortcut', () => {
  it('matches Cmd+Shift+J on Mac', () => {
    expect(
      matchesNativeChatToggleShortcut(combo({ metaKey: true, shiftKey: true }), 'darwin')
    ).toBe(true)
  })

  it('does not match Ctrl+Shift+J on Mac (wrong primary modifier)', () => {
    expect(
      matchesNativeChatToggleShortcut(combo({ ctrlKey: true, shiftKey: true }), 'darwin')
    ).toBe(false)
  })

  it('matches Ctrl+Shift+J on Windows/Linux', () => {
    expect(matchesNativeChatToggleShortcut(combo({ ctrlKey: true, shiftKey: true }), 'win32')).toBe(
      true
    )
  })

  it('requires the shift modifier', () => {
    expect(matchesNativeChatToggleShortcut(combo({ metaKey: true }), 'darwin')).toBe(false)
  })

  it('rejects when alt is held', () => {
    expect(
      matchesNativeChatToggleShortcut(
        combo({ metaKey: true, shiftKey: true, altKey: true }),
        'darwin'
      )
    ).toBe(false)
  })

  it('rejects a different key', () => {
    expect(
      matchesNativeChatToggleShortcut(combo({ key: 'k', metaKey: true, shiftKey: true }), 'darwin')
    ).toBe(false)
  })
})

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
