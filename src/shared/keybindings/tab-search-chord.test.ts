import { describe, expect, it } from 'vitest'
import { findKeybindingActionsForBinding } from './formatting'
import { resolveWindowShortcutAction } from './window-shortcut-policy'
import type { KeybindingOverrides, KeybindingScope } from './types'

const mac = { key: 'a', code: 'KeyA', meta: true, shift: true }
const ctrl = { key: 'A', code: 'KeyA', control: true, shift: true }
const terminal = { context: 'terminal' as const, terminalShortcutPolicy: 'orca-first' as const }

describe('Search Tabs chord routing', () => {
  it('opens tab search everywhere on macOS, terminals and editors included', () => {
    expect(resolveWindowShortcutAction(mac, 'darwin', {}, { context: 'app' })).toEqual({
      type: 'toggleTabSearch'
    })
    expect(resolveWindowShortcutAction(mac, 'darwin', {}, terminal)).toEqual({
      type: 'toggleTabSearch'
    })
  })

  it('leaves Ctrl+Shift+A to Select All in a focused Windows/Linux terminal only', () => {
    for (const platform of ['linux', 'win32'] as const) {
      expect(resolveWindowShortcutAction(ctrl, platform, {}, { context: 'app' })).toEqual({
        type: 'toggleTabSearch'
      })
      expect(resolveWindowShortcutAction(ctrl, platform, {}, terminal)).toBeNull()
      // Rebinding Select All hands the chord back to tab search inside terminals.
      const rebound: KeybindingOverrides = { 'terminal.selectAll': ['Ctrl+Alt+Shift+A'] }
      expect(resolveWindowShortcutAction(ctrl, platform, rebound, terminal)).toEqual({
        type: 'toggleTabSearch'
      })
    }
  })

  it('yields its default to a saved Add Review Note claim on the old chord', () => {
    const kept: KeybindingOverrides = { 'editor.addReviewNote': ['Mod+Shift+A'] }
    expect(resolveWindowShortcutAction(mac, 'darwin', kept, { context: 'app' })).toBeNull()
  })

  it('shares its default chord only with terminal Select All, which routing resolves', () => {
    const scopes: KeybindingScope[] = [
      'global',
      'tabs',
      'terminal',
      'browser',
      'editor',
      'fileExplorer',
      'composer',
      'chat',
      'settings',
      'botItem'
    ]
    const owners = (platform: NodeJS.Platform) =>
      findKeybindingActionsForBinding('Mod+Shift+A', platform, undefined, scopes).toSorted()
    expect(owners('darwin')).toEqual(['tab.search'])
    for (const platform of ['linux', 'win32'] as const) {
      expect(owners(platform)).toEqual(['tab.search', 'terminal.selectAll'])
    }
  })
})
