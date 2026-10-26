import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Terminal } from '@xterm/headless'
import { describe, expect, it } from 'vitest'
import { TerminalKittyKeyboardModeTracker } from '../../../../shared/terminal-kitty-keyboard-mode-tracker'
import {
  resolveTerminalShortcutAction,
  type TerminalShortcutEvent
} from './terminal-shortcut-policy'

// Captured with config/scripts/capture-agent-pty-transcript.mjs (pi 0.74.0, isolated HOME).
const FIXTURE_DIR = join(__dirname, '..', '..', '..', '..', 'main', 'runtime', '__fixtures__')

function readFixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, `${name}.txt`), 'utf8')
}

/** pi's editor rows: the lines between the last two full-width rules above the footer. */
async function renderEditorRows(transcript: string): Promise<string[]> {
  const terminal = new Terminal({ cols: 100, rows: 30, allowProposedApi: true })
  await new Promise<void>((resolve) => terminal.write(transcript, resolve))
  const buffer = terminal.buffer.active
  const rows: string[] = []
  for (let row = 0; row < terminal.rows; row++) {
    rows.push(
      buffer
        .getLine(buffer.viewportY + row)
        ?.translateToString(true)
        .trim() ?? ''
    )
  }
  terminal.dispose()
  const rules = rows.flatMap((text, index) => (/^─{50,}$/.test(text) ? [index] : []))
  const [open, close] = rules.slice(-2)
  return rows.slice(open + 1, close).filter((text) => text.length > 0)
}

function enter(overrides: Partial<TerminalShortcutEvent>): TerminalShortcutEvent {
  return {
    key: 'Enter',
    code: 'Enter',
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    ...overrides
  }
}

function resolveForPane(event: TerminalShortcutEvent, modes: TerminalKittyKeyboardModeTracker) {
  return resolveTerminalShortcutAction(
    event,
    true,
    'false',
    0,
    false,
    undefined,
    undefined,
    () => modes.flags,
    undefined,
    undefined,
    () => false,
    'orca-first',
    undefined,
    () => modes.modifyOtherKeys
  )
}

describe('modified Enter for an app that armed modifyOtherKeys (STA-7701)', () => {
  it('reads pi editing semantics from the captured transcripts', async () => {
    // ESC CR flips meaning with pi's private kitty state, which the pane cannot see.
    expect(await renderEditorRows(readFixture('pi-0-74-modify-other-keys-esc-cr'))).toEqual(['def'])
    expect(await renderEditorRows(readFixture('pi-0-74-late-kitty-esc-cr'))).toEqual(['abc', 'def'])
    // CSI 27 ; mod ; 13 ~ means the same thing in both states.
    for (const name of [
      'pi-0-74-modify-other-keys-shift-enter-csi27',
      'pi-0-74-late-kitty-shift-enter-csi27'
    ]) {
      expect(await renderEditorRows(readFixture(name))).toEqual(['abc', 'def'])
    }
    for (const name of [
      'pi-0-74-modify-other-keys-alt-enter-csi27',
      'pi-0-74-late-kitty-alt-enter-csi27'
    ]) {
      expect(await renderEditorRows(readFixture(name))).toEqual(['def'])
    }
  })

  it('sends xterm modifyOtherKeys Enter chords once pi has armed the mode', () => {
    const modes = new TerminalKittyKeyboardModeTracker()
    modes.scan(readFixture('pi-0-74-modify-other-keys-esc-cr'))
    expect(modes.flags).toBe(0)
    expect(modes.modifyOtherKeys).toBe(2)

    expect(resolveForPane(enter({ shiftKey: true }), modes)).toEqual({
      type: 'sendInput',
      data: '\x1b[27;2;13~'
    })
    expect(resolveForPane(enter({ altKey: true }), modes)).toEqual({
      type: 'sendInput',
      data: '\x1b[27;3;13~'
    })
    expect(resolveForPane(enter({}), modes)).toBeNull()
  })

  it('keeps kitty encoding authoritative and the legacy bytes for apps that armed nothing', () => {
    const kitty = new TerminalKittyKeyboardModeTracker()
    kitty.scan(readFixture('pi-0-74-late-kitty-esc-cr'))
    expect(kitty.flags).toBe(7)
    expect(resolveForPane(enter({ shiftKey: true }), kitty)).toEqual({
      type: 'sendInput',
      data: '\x1b[13;2u'
    })
    // xterm's own kitty encoder handles Alt+Enter.
    expect(resolveForPane(enter({ altKey: true }), kitty)).toBeNull()

    const plain = new TerminalKittyKeyboardModeTracker()
    expect(resolveForPane(enter({ shiftKey: true }), plain)).toEqual({
      type: 'sendInput',
      data: '\x1b\r'
    })
    expect(resolveForPane(enter({ altKey: true }), plain)).toBeNull()
  })

  it('drops the mode on disarm or terminal reset and keeps it across a snapshot', () => {
    const modes = new TerminalKittyKeyboardModeTracker()
    for (const disarm of ['\x1b[>4;0m', '\x1b[>4;m', '\x1b[>4m', '\x1bc']) {
      modes.scan('\x1b[>4;2m')
      expect(modes.modifyOtherKeys).toBe(2)
      modes.scan(disarm)
      expect(modes.modifyOtherKeys).toBe(0)
    }
    modes.scan('\x1b[>4;')
    modes.scan('2m')
    expect(modes.modifyOtherKeys).toBe(2)
    // An older host's snapshot cannot restate the mode, so a snapshot keeps what live output proved.
    modes.resetForSnapshot()
    expect(modes.modifyOtherKeys).toBe(2)
    modes.scanReplay('\x1b[>4;1m')
    expect(modes.modifyOtherKeys).toBe(1)
    modes.reset()
    expect(modes.modifyOtherKeys).toBe(0)
    // Other `CSI > Pp ; Pv m` resources are not modifyOtherKeys.
    modes.scan('\x1b[>1;2m')
    expect(modes.modifyOtherKeys).toBe(0)
  })
})
