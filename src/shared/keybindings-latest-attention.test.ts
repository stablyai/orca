import { describe, expect, it } from 'vitest'
import { findKeybindingConflicts, keybindingMatchesAction } from './keybindings'
import { PLUGIN_COMMAND_ALIAS_ACTION_IDS } from './plugins/plugin-command-actions'

const ACTION = 'worktree.jumpToLatestAttention'

describe('latest attention shortcut', () => {
  it.each(['darwin', 'linux', 'win32'] as const)(
    'matches the platform modifier on %s, including terminal-first policy',
    (platform) => {
      const input = {
        key: 'U',
        code: 'KeyU',
        metaKey: platform === 'darwin',
        ctrlKey: platform !== 'darwin',
        shiftKey: true
      }
      expect(
        keybindingMatchesAction(
          ACTION,
          input,
          platform,
          {},
          { context: 'terminal', terminalShortcutPolicy: 'terminal-first' }
        )
      ).toBe(true)
      expect(keybindingMatchesAction(ACTION, { ...input, shiftKey: false }, platform)).toBe(false)
      expect(findKeybindingConflicts(platform, {}, { relevantActionIds: [ACTION] })).toEqual([])
    }
  )

  it('honors a remapped or disabled binding', () => {
    const original = { code: 'KeyU', key: 'U', metaKey: true, shiftKey: true }
    expect(keybindingMatchesAction(ACTION, original, 'darwin', { [ACTION]: [] })).toBe(false)
    const overrides = { [ACTION]: ['Mod+Alt+J'] }
    expect(keybindingMatchesAction(ACTION, original, 'darwin', overrides)).toBe(false)
    expect(
      keybindingMatchesAction(
        ACTION,
        { code: 'KeyJ', key: 'j', metaKey: true, altKey: true },
        'darwin',
        overrides
      )
    ).toBe(true)
  })

  it('registers the action with the shared app command dispatcher', () => {
    expect(PLUGIN_COMMAND_ALIAS_ACTION_IDS).toContain(ACTION)
  })
})
