import { KITTY_REPORT_EVENT_TYPES } from '../../../../shared/terminal-kitty-keyboard-flags'

type GuardedKeyEvent = Pick<KeyboardEvent, 'type' | 'code' | 'key' | 'keyCode'>

export type TerminalKittyOrphanKeyupGuard = {
  /** Takes the pane handler's verdict for xterm and returns the verdict xterm should get. */
  filter: (event: GuardedKeyEvent, reachesXterm: boolean, kittyKeyboardFlags: number) => boolean
}

/**
 * Keeps a keyup away from xterm unless xterm encoded that key's press. IME-consumed keys (fcitx4
 * letters arriving as keyups only, Hangul's Process/229 presses, a key held across a focus change)
 * otherwise become kitty release reports for presses the app never received.
 */
export function createTerminalKittyOrphanKeyupGuard(): TerminalKittyOrphanKeyupGuard {
  const encodedPressCodes = new Set<string>()
  return {
    filter: (event, reachesXterm, kittyKeyboardFlags) => {
      if (event.type === 'keydown') {
        // xterm routes a 229/Process keydown to its composition helper without encoding it.
        if (reachesXterm && event.keyCode !== 229 && event.key !== 'Process') {
          encodedPressCodes.add(event.code)
        }
        return reachesXterm
      }
      if (event.type !== 'keyup') {
        return reachesXterm
      }
      const pressWasEncoded = encodedPressCodes.delete(event.code)
      // Only report-event-types turns a keyup into bytes; otherwise xterm keeps its keyup bookkeeping.
      if (!reachesXterm || pressWasEncoded) {
        return reachesXterm
      }
      return (kittyKeyboardFlags & KITTY_REPORT_EVENT_TYPES) === 0
    }
  }
}
