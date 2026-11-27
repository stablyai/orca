import { describe, expect, it } from 'vitest'
import { findKeybindingConflicts } from './formatting'
import { keybindingMatchesAction } from './matching'

describe('fileExplorer.toggleDotfiles keybinding invariants', () => {
  it('has no default conflicts on macOS, Linux, or Windows including main-process interception', () => {
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      expect(
        findKeybindingConflicts(
          platform,
          {},
          {
            relevantActionIds: ['fileExplorer.toggleDotfiles'],
            includeMainProcessInterception: true
          }
        )
      ).toEqual([])
    }
  })

  it('matches Cmd+Shift+. on macOS and Ctrl+Shift+. on Linux/Windows across both . and shifted >', () => {
    expect(
      keybindingMatchesAction(
        'fileExplorer.toggleDotfiles',
        { key: '.', code: 'Period', metaKey: true, shiftKey: true },
        'darwin'
      )
    ).toBe(true)
    expect(
      keybindingMatchesAction(
        'fileExplorer.toggleDotfiles',
        { key: '>', code: 'Period', metaKey: true, shiftKey: true },
        'darwin'
      )
    ).toBe(true)
    expect(
      keybindingMatchesAction(
        'fileExplorer.toggleDotfiles',
        { key: '>', code: 'Period', ctrlKey: true, shiftKey: true },
        'darwin'
      )
    ).toBe(false)

    for (const platform of ['linux', 'win32'] as const) {
      expect(
        keybindingMatchesAction(
          'fileExplorer.toggleDotfiles',
          { key: '>', code: 'Period', ctrlKey: true, shiftKey: true },
          platform
        )
      ).toBe(true)
      expect(
        keybindingMatchesAction(
          'fileExplorer.toggleDotfiles',
          { key: '.', code: 'Period', ctrlKey: true, shiftKey: true },
          platform
        )
      ).toBe(true)
      expect(
        keybindingMatchesAction(
          'fileExplorer.toggleDotfiles',
          { key: 'h', code: 'KeyH', ctrlKey: true },
          platform
        )
      ).toBe(false)
    }
  })

  it('honors user rebindings and explicit unbinding', () => {
    expect(
      keybindingMatchesAction(
        'fileExplorer.toggleDotfiles',
        { key: 'h', code: 'KeyH', ctrlKey: true },
        'linux',
        { 'fileExplorer.toggleDotfiles': ['Mod+H'] }
      )
    ).toBe(true)
    expect(
      keybindingMatchesAction(
        'fileExplorer.toggleDotfiles',
        { key: '>', code: 'Period', ctrlKey: true, shiftKey: true },
        'linux',
        { 'fileExplorer.toggleDotfiles': [] }
      )
    ).toBe(false)
  })
})
