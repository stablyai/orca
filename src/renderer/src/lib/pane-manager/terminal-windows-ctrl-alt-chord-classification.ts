import type { Terminal } from '@xterm/xterm'

// Why: xterm misclassifies Windows Ctrl+Alt chords as AltGr and drops the ones
// that never compose a keypress (#8734); repairing the classification lets
// xterm's own protocol-aware key encoders emit the bytes.
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

/**
 * Returns whether a Windows Ctrl+Alt chord is genuine keyboard input rather
 * than AltGr composition, and must therefore reach xterm's key encoders.
 *
 * When a Ctrl+Alt keydown composes a printable character on the active
 * layout, Chromium replaces the Control+Alt modifiers with AltGraph
 * (crbug 762557), so a chord still reporting Ctrl+Alt without AltGraph
 * cannot compose text.
 */
export function isGenuineWindowsCtrlAltChord(event: ThirdLevelShiftKeyboardEvent): boolean {
  return (
    event.ctrlKey && event.altKey && !event.metaKey && event.getModifierState?.('AltGraph') !== true
  )
}

/** Returns whether this client's AltGraph modifier state is trustworthy. */
export function shouldRepairWindowsCtrlAltChords(userAgent: string): boolean {
  // Why: only Chromium rewrites composing Ctrl+Alt presses to AltGraph. Paired
  // web clients on Firefox keep stock classification so Ctrl+Alt-alias AltGr
  // typing there is never misread as a chord.
  return userAgent.includes('Windows') && userAgent.includes('Chrome/')
}

/**
 * Narrow xterm's Windows third-level-shift classification so genuine
 * Ctrl+Alt chords flow into its protocol-aware key encoders instead of
 * being dropped. Only ever flips a third-level verdict to false — AltGr,
 * macOS option handling, and every non-Windows path are untouched.
 *
 * Returns false when the internal seam is unavailable (e.g. after an xterm
 * upgrade), degrading to the historical drop-the-chord behavior.
 */
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
