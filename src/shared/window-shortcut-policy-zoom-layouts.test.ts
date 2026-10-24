// Zoom chords as the active keyboard layout reports them, not as a US layout spells them.
import { describe, expect, it } from 'vitest'
import { resolveWindowShortcutAction, type WindowShortcutInput } from './window-shortcut-policy'

describe('resolveWindowShortcutAction', () => {
  it('zooms in when the layout reports plus or equal without the US Shift state', () => {
    // Why: on Latin American, German, and Italian layouts '+' is its own key, so it arrives
    // with no Shift; on those and others '=' sits behind Shift and arrives as '='.
    const layoutCases: WindowShortcutInput[] = [
      { key: '+', code: 'BracketRight', meta: false, control: true, alt: false, shift: false },
      { key: '=', code: 'Digit0', meta: false, control: true, alt: false, shift: true }
    ]

    for (const input of layoutCases) {
      expect(resolveWindowShortcutAction(input, 'win32')).toEqual({
        type: 'zoom',
        direction: 'in'
      })
    }
  })

  it('does not zoom in on the shifted character of the same key', () => {
    // Why: Shift on the Latin American '+' key types '*', which no zoom binding owns.
    expect(
      resolveWindowShortcutAction(
        { key: '*', code: 'BracketRight', meta: false, control: true, alt: false, shift: true },
        'win32'
      )
    ).toBeNull()
  })
})
