import { describe, expect, it } from 'vitest'
import type { KeybindingActionId } from '../../../../shared/keybindings'
import { clearRecordingActionForShortcutMutation } from './shortcut-recording-state'

describe('clearRecordingActionForShortcutMutation', () => {
  it('ends recording when the edited shortcut is disabled or reset', () => {
    expect(
      clearRecordingActionForShortcutMutation(
        'app.settings' satisfies KeybindingActionId,
        'app.settings'
      )
    ).toBeNull()
  })

  it('keeps a different active recorder untouched', () => {
    expect(
      clearRecordingActionForShortcutMutation(
        'app.settings' satisfies KeybindingActionId,
        'tab.close'
      )
    ).toBe('app.settings')
  })
})
