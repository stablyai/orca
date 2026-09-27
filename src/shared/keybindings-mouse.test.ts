import { describe, expect, it } from 'vitest'
import {
  findKeybindingConflicts,
  formatKeybinding,
  keybindingFromInputForAction,
  keybindingMatchesInput,
  normalizeKeybinding,
  normalizeKeybindingArrayForAction
} from './keybindings'

describe('mouse button keybindings', () => {
  it.each(['MouseBack', 'MouseForward'])('accepts %s with optional modifiers', (key) => {
    for (const prefix of ['', 'Shift+', 'Alt+', 'Mod+Shift+']) {
      expect(normalizeKeybinding(`${prefix}${key.toLowerCase()}`)).toEqual({
        ok: true,
        value: `${prefix}${key}`
      })
    }
  })

  it.each(['darwin', 'linux', 'win32'] as const)(
    'captures and matches modifiers on %s',
    (platform) => {
      const input = {
        key: 'MouseBack',
        metaKey: platform === 'darwin',
        ctrlKey: platform !== 'darwin',
        shiftKey: true
      }
      expect(keybindingFromInputForAction('tab.previousTerminal', input, platform)).toEqual({
        ok: true,
        value: 'Mod+Shift+MouseBack'
      })
      expect(keybindingMatchesInput('Mod+Shift+MouseBack', input, platform)).toBe(true)
      expect(keybindingMatchesInput('MouseBack', input, platform)).toBe(false)
      expect(keybindingMatchesInput('Mod+Shift+MouseForward', input, platform)).toBe(false)
      expect(formatKeybinding('Mod+MouseBack', platform)).toEqual([
        platform === 'darwin' ? '⌘' : 'Ctrl',
        'Mouse Back'
      ])
    }
  )

  it('finds mouse conflicts and retains digit-index validation', () => {
    expect(
      findKeybindingConflicts('linux', {
        'tab.nextTerminal': ['MouseForward'],
        'tab.previousTerminal': ['MouseForward']
      })
    ).toEqual([
      {
        binding: 'MouseForward',
        actionIds: expect.arrayContaining(['tab.nextTerminal', 'tab.previousTerminal'])
      }
    ])
    expect(normalizeKeybindingArrayForAction('tab.selectByIndex', ['MouseBack'])).toMatchObject({
      ok: false
    })
    expect(normalizeKeybinding('MouseMiddle')).toMatchObject({ ok: false })
    expect(normalizeKeybinding('A')).toMatchObject({ ok: false })
  })
})
