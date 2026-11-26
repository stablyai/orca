import type { Terminal } from '@xterm/xterm'

// Repair Windows Ctrl+Alt misclassification as AltGr (#8734), leaving byte encoding to xterm’s protocol-aware service.
type ThirdLevelShiftBrowserInfo = { isWindows?: boolean }

type ThirdLevelShiftKeyboardEvent = Pick<KeyboardEvent, 'ctrlKey' | 'altKey' | 'metaKey'> & {
  getModifierState?: (keyArg: string) => boolean
}

type TerminalWithThirdLevelShift = {
  _core?: {
    _isThirdLevelShift?: (
      browser: ThirdLevelShiftBrowserInfo,
      event: ThirdLevelShiftKeyboardEvent
    ) => boolean
  }
}

/** Genuine Windows Ctrl+Alt must reach xterm encoders. Chromium rewrites printable composing Ctrl+Alt to AltGraph (crbug 762557), so retained Ctrl+Alt without AltGraph cannot compose text. */
export function isGenuineWindowsCtrlAltChord(event: ThirdLevelShiftKeyboardEvent): boolean {
  return (
    event.ctrlKey && event.altKey && !event.metaKey && event.getModifierState?.('AltGraph') !== true
  )
}

/** Returns whether this client's AltGraph modifier state is trustworthy. */
export function shouldRepairWindowsCtrlAltChords(userAgent: string): boolean {
  // Only Chromium rewrites composing Ctrl+Alt to AltGraph; keep stock classification on Firefox paired clients to protect AltGr typing.
  return userAgent.includes('Windows') && userAgent.includes('Chrome/')
}

/** Only narrow Windows third-level-shift verdicts so genuine Ctrl+Alt reaches xterm encoders; preserve AltGr/macOS/non-Windows behavior. Missing private seams return false and retain historical chord drops. */
export function installWindowsCtrlAltChordRepair(
  terminal: Terminal,
  userAgent: string = navigator.userAgent
): boolean {
  if (!shouldRepairWindowsCtrlAltChords(userAgent)) {
    return false
  }
  const core = (terminal as unknown as TerminalWithThirdLevelShift)._core
  const stockClassification = core?._isThirdLevelShift
  if (!core || typeof stockClassification !== 'function') {
    console.warn(
      'xterm no longer exposes _core._isThirdLevelShift; Windows Ctrl+Alt chords will be dropped'
    )
    return false
  }
  core._isThirdLevelShift = function (browser, event) {
    const thirdLevel = stockClassification.call(this, browser, event)
    if (!thirdLevel || browser?.isWindows !== true) {
      return thirdLevel
    }
    return !isGenuineWindowsCtrlAltChord(event)
  }
  return true
}
