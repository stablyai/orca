// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/xterm'
import {
  installWindowsCtrlAltChordRepair,
  isGenuineWindowsCtrlAltChord,
  shouldRepairWindowsCtrlAltChords
} from './terminal-windows-ctrl-alt-chord-classification'

const WINDOWS_ELECTRON_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'orca/1.0.0 Chrome/126.0.0.0 Electron/31.0.0 Safari/537.36'
const WINDOWS_FIREFOX_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0'
const MAC_ELECTRON_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
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
  _keyboardService?: { evaluateKeyDown?: (event: unknown) => { key?: string } | undefined }
  coreService?: { kittyKeyboard?: { flags: number } }
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

describe('isGenuineWindowsCtrlAltChord', () => {
  it('accepts Ctrl+Alt chords whose AltGraph state is false', () => {
    expect(isGenuineWindowsCtrlAltChord(chord())).toBe(true)
    expect(isGenuineWindowsCtrlAltChord(chord({ shiftKey: true }))).toBe(true)
    // Synthetic events without getModifierState cannot be AltGr composition.
    expect(isGenuineWindowsCtrlAltChord(chord({ getModifierState: undefined }))).toBe(true)
  })

  it('rejects AltGr composition and non-Ctrl+Alt chords', () => {
    expect(
      isGenuineWindowsCtrlAltChord(chord({ getModifierState: (key) => key === 'AltGraph' }))
    ).toBe(false)
    expect(isGenuineWindowsCtrlAltChord(chord({ metaKey: true }))).toBe(false)
    expect(isGenuineWindowsCtrlAltChord(chord({ altKey: false }))).toBe(false)
    expect(isGenuineWindowsCtrlAltChord(chord({ ctrlKey: false }))).toBe(false)
  })
})

describe('shouldRepairWindowsCtrlAltChords', () => {
  it('repairs only Windows Chromium clients', () => {
    expect(shouldRepairWindowsCtrlAltChords(WINDOWS_ELECTRON_UA)).toBe(true)
    // Why: Firefox does not rewrite composing Ctrl+Alt presses to AltGraph, so
    // a false AltGraph state there does not prove the chord is genuine.
    expect(shouldRepairWindowsCtrlAltChords(WINDOWS_FIREFOX_UA)).toBe(false)
    expect(shouldRepairWindowsCtrlAltChords(MAC_ELECTRON_UA)).toBe(false)
  })
})

describe('installWindowsCtrlAltChordRepair', () => {
  it('finds the internal classification seam on the real Terminal', () => {
    // Upgrade tripwire: if a future xterm rename removes the seam, this fails
    // loudly instead of silently reverting to dropped Ctrl+Alt chords.
    const terminal = new Terminal()
    try {
      expect(getThirdLevelShift(terminal)({ isWindows: true }, chord())).toBe(true)
      expect(installWindowsCtrlAltChordRepair(terminal, WINDOWS_ELECTRON_UA)).toBe(true)
    } finally {
      terminal.dispose()
    }
  })

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

  it('declines on clients without trustworthy AltGraph state', () => {
    const terminal = new Terminal()
    try {
      expect(installWindowsCtrlAltChordRepair(terminal, WINDOWS_FIREFOX_UA)).toBe(false)
      expect(getThirdLevelShift(terminal)({ isWindows: true }, chord())).toBe(true)
    } finally {
      terminal.dispose()
    }
  })
})

// Why: the repair intentionally adds no encoder — rescued chords must produce
// whatever bytes xterm's own keyboard service computes for the protocol the
// foreground app negotiated. These pin that contract for both protocol tiers.
describe('rescued chords are encoded by xterm, not Orca', () => {
  function keyDownChord(overrides: Record<string, unknown>): Record<string, unknown> {
    return { ...chord(), repeat: false, ...overrides }
  }

  function getEvaluateKeyDown(
    terminal: Terminal
  ): (event: unknown) => { key?: string } | undefined {
    const service = getCore(terminal)._keyboardService
    if (typeof service?.evaluateKeyDown !== 'function') {
      throw new Error('xterm no longer exposes _core._keyboardService.evaluateKeyDown')
    }
    return service.evaluateKeyDown.bind(service)
  }

  it('legacy encoder emits Alt-prefixed bytes matching the Windows E2E', () => {
    const terminal = new Terminal()
    try {
      installWindowsCtrlAltChordRepair(terminal, WINDOWS_ELECTRON_UA)
      const evaluate = getEvaluateKeyDown(terminal)
      expect(evaluate(keyDownChord({ key: 'u', code: 'KeyU', keyCode: 85 }))?.key).toBe('\x1b\x15')
      expect(evaluate(keyDownChord({ key: '2', code: 'Digit2', keyCode: 50 }))?.key).toBe('\x1b2')
      expect(evaluate(keyDownChord({ key: ';', code: 'Semicolon', keyCode: 186 }))?.key).toBe(
        '\x1b;'
      )
    } finally {
      terminal.dispose()
    }
  })

  it('kitty encoder takes over once the app negotiates progressive flags', () => {
    const terminal = new Terminal({ vtExtensions: { kittyKeyboard: true } })
    try {
      installWindowsCtrlAltChordRepair(terminal, WINDOWS_ELECTRON_UA)
      const kitty = getCore(terminal).coreService?.kittyKeyboard
      expect(kitty).toBeTruthy()
      kitty!.flags = 1
      const evaluate = getEvaluateKeyDown(terminal)
      expect(evaluate(keyDownChord({ key: 'u', code: 'KeyU', keyCode: 85 }))?.key).toBe(
        '\x1b[117;7u'
      )
    } finally {
      terminal.dispose()
    }
  })
})
