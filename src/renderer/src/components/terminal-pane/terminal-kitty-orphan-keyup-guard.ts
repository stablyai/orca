import { KITTY_REPORT_EVENT_TYPES } from '../../../../shared/terminal-kitty-keyboard-flags'

type GuardedKeyEvent = Pick<KeyboardEvent, 'type' | 'code' | 'key' | 'keyCode'>

export type TerminalKittyOrphanKeyupGuard = {
  /** Takes the pane handler's verdict for xterm and returns the verdict xterm should get. */
  filter: (event: GuardedKeyEvent, reachesXterm: boolean, kittyKeyboardFlags: number) => boolean
}

/** Suppress keyup unless xterm encoded its press; IME-consumed keys and focus changes otherwise create orphan Kitty release reports. */
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
