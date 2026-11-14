import { describe, expect, it } from 'vitest'
import {
  getEffectiveKeybindingsForAction,
  getKeybindingDefinition,
  keybindingMatchesAction
} from './keybindings'
import type { KeybindingActionId, KeybindingPlatform } from './keybindings'

describe('keybindings', () => {
  it('keeps editor view commands unassigned until users customize them', () => {
    const actions: readonly [KeybindingActionId, string, readonly string[]][] = [
      ['editor.toggleChanges', 'Toggle Changes', ['shortcut', 'editor', 'view', 'changes']],
      ['editor.cycleViewMode', 'Cycle Editor View', ['shortcut', 'editor', 'view', 'cycle']]
    ]
    const platforms: readonly KeybindingPlatform[] = ['darwin', 'linux', 'win32']
    const binding = {
      key: 'c',
      code: 'KeyC',
      control: true,
      meta: false,
      alt: true,
      shift: false
    }

    for (const [rawActionId, title, searchKeywords] of actions) {
      const definition = getKeybindingDefinition(rawActionId)
      expect(definition).toMatchObject({
        id: rawActionId,
        title,
        group: 'Editors',
        scope: 'editor',
        searchKeywords: expect.arrayContaining([...searchKeywords])
      })

      for (const platform of platforms) {
        expect(getEffectiveKeybindingsForAction(rawActionId, platform)).toEqual([])
        expect(keybindingMatchesAction(rawActionId, binding, platform)).toBe(false)
        expect(
          keybindingMatchesAction(rawActionId, binding, platform, {
            [rawActionId]: ['Ctrl+Alt+C']
          })
        ).toBe(true)
      }
    }
  })
})
