import { describe, expect, it } from 'vitest'
import {
  findKeybindingConflicts,
  getEffectiveKeybindingsForAction,
  getKeybindingDefinition,
  KEYBINDING_DEFINITIONS,
  keybindingMatchesAction
} from '../keybindings'
import { DEBUG_KEYBINDING_ACTION_IDS } from './definitions-debug'

const PLATFORMS = ['darwin', 'linux', 'win32'] as const

describe('debug keybindings', () => {
  it.each(PLATFORMS)("binds VS Code's debug chords on %s", (platform) => {
    const stepInto = platform === 'darwin' ? ['F11'] : []
    expect(getEffectiveKeybindingsForAction('debug.startOrContinue', platform)).toEqual(['F5'])
    expect(getEffectiveKeybindingsForAction('debug.stop', platform)).toEqual(['Shift+F5'])
    expect(getEffectiveKeybindingsForAction('debug.restart', platform)).toEqual(['Mod+Shift+F5'])
    expect(getEffectiveKeybindingsForAction('debug.pause', platform)).toEqual(['F6'])
    expect(getEffectiveKeybindingsForAction('debug.stepOver', platform)).toEqual(['F10'])
    expect(getEffectiveKeybindingsForAction('debug.stepInto', platform)).toEqual(stepInto)
    expect(getEffectiveKeybindingsForAction('debug.stepOut', platform)).toEqual(['Shift+F11'])
    expect(getEffectiveKeybindingsForAction('debug.toggleBreakpoint', platform)).toEqual(['F9'])
  })

  it('scopes the breakpoint toggle to the editor and the session chords globally', () => {
    for (const id of DEBUG_KEYBINDING_ACTION_IDS) {
      const definition = getKeybindingDefinition(id)
      expect(definition?.allowBareKeybindings).toBe(true)
      expect(definition?.scope).toBe(id === 'debug.toggleBreakpoint' ? 'editor' : 'global')
    }
  })

  it.each(PLATFORMS)('reports no conflicts on %s', (platform) => {
    expect(
      findKeybindingConflicts(platform, undefined, {
        relevantActionIds: DEBUG_KEYBINDING_ACTION_IDS
      })
    ).toEqual([])
    expect(findKeybindingConflicts(platform)).toEqual([])
  })

  it.each(PLATFORMS)('claims no chord another action owns in any scope on %s', (platform) => {
    const debugIds = new Set<string>(DEBUG_KEYBINDING_ACTION_IDS)
    const others = KEYBINDING_DEFINITIONS.filter((definition) => !debugIds.has(definition.id))
      .flatMap((definition) => getEffectiveKeybindingsForAction(definition.id, platform))
      .map((binding) => binding.toLowerCase())
    for (const id of DEBUG_KEYBINDING_ACTION_IDS) {
      for (const binding of getEffectiveKeybindingsForAction(id, platform)) {
        expect(others).not.toContain(binding.toLowerCase())
      }
    }
  })

  it('matches a bare F5 and a Shift+F5 key event', () => {
    const f5 = { key: 'F5', code: 'F5', meta: false, control: false, alt: false, shift: false }
    expect(keybindingMatchesAction('debug.startOrContinue', f5, 'linux')).toBe(true)
    expect(keybindingMatchesAction('debug.stop', { ...f5, shift: true }, 'linux')).toBe(true)
    expect(keybindingMatchesAction('debug.startOrContinue', { ...f5, shift: true }, 'linux')).toBe(
      false
    )
  })
})
