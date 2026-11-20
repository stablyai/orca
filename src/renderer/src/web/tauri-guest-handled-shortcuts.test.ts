// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { KEYBINDING_DEFINITIONS } from '../../../shared/keybindings/definitions'
import type { KeybindingOverrides } from '../../../shared/keybindings/types'
import {
  EVENT_BROWSER_HANDLED_SHORTCUTS,
  computeTauriGuestHandledShortcuts,
  publishTauriGuestHandledShortcuts
} from './tauri-guest-handled-shortcuts'

type HostCall = unknown[]
const host = vi.hoisted((): { available: boolean; invoked: HostCall[]; emitted: HostCall[] } => ({
  available: true,
  invoked: [],
  emitted: []
}))

vi.mock('./tauri-native-host', () => ({
  isTauriNativeHost: () => host.available,
  invokeNative: (...args: unknown[]) => {
    host.invoked.push(args)
    return Promise.resolve()
  },
  emitNative: (...args: unknown[]) => {
    host.emitted.push(args)
    return Promise.resolve()
  }
}))

function overridesForFirstDefinition(binding: string): KeybindingOverrides {
  const target = KEYBINDING_DEFINITIONS[0]
  if (!target) {
    throw new Error('No keybinding definitions to test against.')
  }
  const overrides: KeybindingOverrides = {}
  overrides[target.id] = [binding]
  return overrides
}

describe('computeTauriGuestHandledShortcuts', () => {
  it('emits physical and logical entries for a Ctrl letter chord', () => {
    const chords = computeTauriGuestHandledShortcuts({
      platform: 'win32',
      overrides: overridesForFirstDefinition('Ctrl+B')
    })
    expect(chords).toContain('c:1000:KeyB')
    expect(chords).toContain('k:1000:B')
    expect([...chords].sort()).toEqual(chords)
  })

  it('resolves Mod per platform', () => {
    const windows = computeTauriGuestHandledShortcuts({
      platform: 'win32',
      overrides: overridesForFirstDefinition('Mod+B')
    })
    expect(windows).toContain('c:1000:KeyB')
    const mac = computeTauriGuestHandledShortcuts({
      platform: 'darwin',
      overrides: overridesForFirstDefinition('Mod+B')
    })
    expect(mac).toContain('c:0001:KeyB')
    expect(mac).not.toContain('c:1000:KeyB')
  })

  it('skips double-tap and unreadable bindings without dropping the set', () => {
    const chords = computeTauriGuestHandledShortcuts({
      platform: 'win32',
      overrides: overridesForFirstDefinition('DoubleTap+Ctrl')
    })
    expect(Array.isArray(chords)).toBe(true)
    for (const chord of chords) {
      expect(chord).toMatch(/^[ck]:[01]{4}:/)
    }
    const broken = computeTauriGuestHandledShortcuts({
      platform: 'win32',
      overrides: overridesForFirstDefinition('Ctrl+')
    })
    expect(Array.isArray(broken)).toBe(true)
  })
})

describe('publishTauriGuestHandledShortcuts', () => {
  beforeEach(() => {
    host.available = true
    host.invoked.length = 0
    host.emitted.length = 0
  })

  it('pushes the set to Rust state and live guests', async () => {
    await publishTauriGuestHandledShortcuts(['c:1000:KeyB'])
    expect(host.invoked).toEqual([
      ['poc_browser_set_handled_shortcuts', { args: { chords: ['c:1000:KeyB'] } }]
    ])
    expect(host.emitted).toEqual([[EVENT_BROWSER_HANDLED_SHORTCUTS, { chords: ['c:1000:KeyB'] }]])
  })

  it('stays silent off the Tauri host', async () => {
    host.available = false
    await publishTauriGuestHandledShortcuts(['c:1000:KeyB'])
    expect(host.invoked).toEqual([])
    expect(host.emitted).toEqual([])
  })
})
