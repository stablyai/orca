// @vitest-environment happy-dom
// Mouse-capturing Kitty TUIs own their selection, so unselected Ctrl+Shift+C must reach them as CSI-u.
import { describe, expect, it } from 'vitest'
import {
  replayThroughLinuxPane,
  useLinuxPaneTestEnvironment,
  type RecordedDomEvent
} from '../ime/terminal-ime-linux-pane-replay-fixture'

const CTRL_SHIFT_C = { key: 'C', code: 'KeyC', keyCode: 67, ctrlKey: true, shiftKey: true }
const CHORD: RecordedDomEvent[] = [
  { type: 'keydown', ...CTRL_SHIFT_C },
  { type: 'keyup', ...CTRL_SHIFT_C }
]

describe('Linux pane unselected Ctrl+Shift+C', () => {
  useLinuxPaneTestEnvironment()

  it('sends the Kitty CSI-u chord to a TUI that negotiated Kitty keyboard flags', async () => {
    const { emitted, preventedKeydownCodes } = await replayThroughLinuxPane(CHORD, '\x1b[>1u')
    expect(emitted).toBe('\x1b[99;6u')
    expect(preventedKeydownCodes).toEqual(['KeyC'])
  })

  it('sends nothing to a plain shell without Kitty keyboard flags', async () => {
    const { emitted, preventedKeydownCodes } = await replayThroughLinuxPane(CHORD)
    expect(emitted).toBe('')
    // Left uncancelled so Chromium's native copy event still fires.
    expect(preventedKeydownCodes).toEqual([])
  })
})
