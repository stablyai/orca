import { describe, expect, it } from 'vitest'
import { normalizeOsc52ClipboardDefaultOn } from './osc52-clipboard-settings'

describe('normalizeOsc52ClipboardDefaultOn', () => {
  it('flips an unstamped profile on, because its `false` came from the old default', () => {
    // Old profiles persisted the false default, indistinguishable from deliberate opt-out (#10567).
    expect(normalizeOsc52ClipboardDefaultOn({ terminalAllowOsc52Clipboard: false })).toEqual({
      terminalAllowOsc52Clipboard: true,
      terminalAllowOsc52ClipboardDefaultedOnForAllUsers: true
    })
  })

  it('leaves a stamped opt-out off', () => {
    expect(
      normalizeOsc52ClipboardDefaultOn({
        terminalAllowOsc52Clipboard: false,
        terminalAllowOsc52ClipboardDefaultedOnForAllUsers: true
      })
    ).toEqual({
      terminalAllowOsc52Clipboard: false,
      terminalAllowOsc52ClipboardDefaultedOnForAllUsers: true
    })
  })
})
