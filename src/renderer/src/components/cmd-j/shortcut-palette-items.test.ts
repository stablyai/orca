import { describe, expect, it } from 'vitest'
import { getShortcutSettingsTarget } from './shortcut-palette-items'

describe('shortcut palette item selection', () => {
  it('builds an action-specific Shortcuts settings target', () => {
    expect(getShortcutSettingsTarget('terminal.splitRight')).toEqual({
      pane: 'shortcuts',
      repoId: null,
      intent: 'shortcut-action',
      actionId: 'terminal.splitRight'
    })
  })
})
