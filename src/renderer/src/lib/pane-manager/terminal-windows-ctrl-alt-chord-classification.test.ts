// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/xterm'
import { installWindowsCtrlAltChordRepair } from './terminal-windows-ctrl-alt-chord-classification'

const WINDOWS_ELECTRON_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'orca/1.0.0 Chrome/126.0.0.0 Electron/31.0.0 Safari/537.36'

type ClassificationEvent = {
  type: string
  keyCode: number
  ctrlKey: boolean
  altKey: boolean
  metaKey: boolean
  shiftKey?: boolean
  getModifierState?: (keyArg: string) => boolean
}

function chord(overrides: Partial<ClassificationEvent> = {}): ClassificationEvent {
  return {
    type: 'keydown',
    keyCode: 85,
    ctrlKey: true,
    altKey: true,
    metaKey: false,
    getModifierState: () => false,
    ...overrides
  }
}

type CoreThirdLevelShift = (
  browser: { isMac?: boolean; isWindows?: boolean },
  event: ClassificationEvent
) => boolean

type XtermCoreInternals = {
  _isThirdLevelShift?: CoreThirdLevelShift
}

function getCore(terminal: Terminal): XtermCoreInternals {
  return (terminal as unknown as { _core?: XtermCoreInternals })._core ?? {}
}

function getThirdLevelShift(terminal: Terminal): CoreThirdLevelShift {
  const core = getCore(terminal)
  const classify = core._isThirdLevelShift
  if (typeof classify !== 'function') {
    throw new Error('xterm no longer exposes _core._isThirdLevelShift')
  }
  return classify.bind(core)
}

describe('installWindowsCtrlAltChordRepair', () => {
  it('reclassifies only genuine Windows Ctrl+Alt chords', () => {
    const terminal = new Terminal()
    try {
      installWindowsCtrlAltChordRepair(terminal, WINDOWS_ELECTRON_UA)
      const classify = getThirdLevelShift(terminal)
      const windows = { isWindows: true }
      expect(classify(windows, chord())).toBe(false)
      expect(classify(windows, chord({ shiftKey: true }))).toBe(false)
      // AltGr composition keeps xterm's third-level-shift handling.
      expect(classify(windows, chord({ getModifierState: (key) => key === 'AltGraph' }))).toBe(true)
      // macOS option-as-third-level-shift is untouched.
      expect(
        classify({ isMac: true }, chord({ ctrlKey: false, getModifierState: () => false }))
      ).toBe(true)
    } finally {
      terminal.dispose()
    }
  })
})
