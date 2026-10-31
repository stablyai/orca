import { describe, expect, it } from 'vitest'
import { matchTiledAgentsShortcut } from './tiled-agents-shortcuts'

type Platform = 'darwin' | 'linux' | 'win32'
const PLATFORMS: readonly Platform[] = ['darwin', 'linux', 'win32']

// Mod+Alt+<key>: meta+alt on darwin, control+alt on linux/win32.
function modAlt(key: string, platform: Platform): Parameters<typeof matchTiledAgentsShortcut>[0] {
  return platform === 'darwin'
    ? { key, metaKey: true, ctrlKey: false, altKey: true, shiftKey: false }
    : { key, metaKey: false, ctrlKey: true, altKey: true, shiftKey: false }
}

describe('matchTiledAgentsShortcut', () => {
  it('matches Mod+Alt+1 through Mod+Alt+9 as a zero-based focusPane index on every platform', () => {
    for (const platform of PLATFORMS) {
      for (let digit = 1; digit <= 9; digit++) {
        expect(matchTiledAgentsShortcut(modAlt(String(digit), platform), platform, {})).toEqual({
          type: 'focusPane',
          index: digit - 1
        })
      }
    }
  })

  it('matches Mod+Alt+Enter as toggleMaximize on every platform', () => {
    for (const platform of PLATFORMS) {
      expect(matchTiledAgentsShortcut(modAlt('Enter', platform), platform, {})).toEqual({
        type: 'toggleMaximize'
      })
    }
  })

  it('does not match Mod+1 (workspace.selectByIndex, no Alt)', () => {
    expect(
      matchTiledAgentsShortcut(
        { key: '1', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false },
        'darwin',
        {}
      )
    ).toBeNull()
    expect(
      matchTiledAgentsShortcut(
        { key: '1', metaKey: false, ctrlKey: true, altKey: false, shiftKey: false },
        'linux',
        {}
      )
    ).toBeNull()
  })

  it('does not match Ctrl+1 on darwin (tab.selectByIndex, no Alt)', () => {
    expect(
      matchTiledAgentsShortcut(
        { key: '1', metaKey: false, ctrlKey: true, altKey: false, shiftKey: false },
        'darwin',
        {}
      )
    ).toBeNull()
  })

  it('respects custom bindings for focusPaneByIndex', () => {
    expect(
      matchTiledAgentsShortcut(
        { key: '5', metaKey: false, ctrlKey: true, altKey: true, shiftKey: true },
        'linux',
        { 'tiling.focusPaneByIndex': ['Mod+Alt+Shift+1'] }
      )
    ).toEqual({ type: 'focusPane', index: 4 })
  })

  it('returns null for an unrelated chord', () => {
    expect(
      matchTiledAgentsShortcut(
        { key: 'k', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false },
        'darwin',
        {}
      )
    ).toBeNull()
  })
})
