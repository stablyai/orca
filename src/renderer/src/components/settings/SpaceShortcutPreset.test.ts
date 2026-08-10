import { describe, expect, it } from 'vitest'
import type { KeybindingOverrides } from '../../../../shared/keybindings'
import { getSpaceShortcutPreset } from './SpaceShortcutPreset'

// Arc moves workspaces onto the secondary digit row, which is Ctrl+Shift in each platform's
// canonical form (⇧⌘3-6 are macOS screenshot chords, so Mod+Shift is unusable there).
function arcOverrides(secondaryDigitRow: string): KeybindingOverrides {
  return {
    'space.selectByIndex': ['Mod+1'],
    'workspace.selectByIndex': [secondaryDigitRow],
    'space.next': ['Mod+Alt+ArrowRight'],
    'space.previous': ['Mod+Alt+ArrowLeft'],
    'worktree.history.back': ['Mod+Alt+Shift+ArrowLeft'],
    'worktree.history.forward': ['Mod+Alt+Shift+ArrowRight']
  }
}

describe('Space shortcut preset', () => {
  it('reads the shipped catalog as the Orca preset', () => {
    expect(getSpaceShortcutPreset('darwin', {})).toBe('default')
    expect(getSpaceShortcutPreset('win32', {})).toBe('default')
  })

  it('recognizes the Arc layout on every platform', () => {
    expect(getSpaceShortcutPreset('darwin', arcOverrides('Ctrl+Shift+1'))).toBe('arc')
    expect(getSpaceShortcutPreset('linux', arcOverrides('Mod+Shift+1'))).toBe('arc')
    expect(getSpaceShortcutPreset('win32', arcOverrides('Mod+Shift+1'))).toBe('arc')
  })

  it('reports a partially applied or hand-edited layout as custom', () => {
    expect(getSpaceShortcutPreset('darwin', { 'space.selectByIndex': ['Mod+1'] })).toBe('custom')
    expect(
      getSpaceShortcutPreset('darwin', {
        ...arcOverrides('Ctrl+Shift+1'),
        'space.next': ['Mod+Alt+ArrowUp']
      })
    ).toBe('custom')
    // The macOS row must not be reachable through the Mod+Shift form.
    expect(getSpaceShortcutPreset('darwin', arcOverrides('Mod+Shift+1'))).toBe('custom')
  })
})
