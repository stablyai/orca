import { KITTY_REPORT_EVENT_TYPES } from '../../../../shared/terminal-kitty-keyboard-flags'
import {
  encodeTerminalOptionKittyEvent,
  optionKittyPrimaryCharacterFallback,
  resolveTerminalKittyPrimaryCodePoint
} from './terminal-kitty-csi-u-encoding'
import { withoutKittyLockModifiers } from './terminal-kitty-select-all'

export type TerminalOptionKittyRelease = {
  flags: number
  // Why: a press encoded without lock modifiers (forwarded Cmd+A) needs a release that matches it.
  ignoreLockModifiers?: boolean
}

type OptionKeyboardEvent = {
  key: string
  code?: string
  shiftKey: boolean
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  repeat?: boolean
  getModifierState?: (key: string) => boolean
  capsLock?: boolean
  numLock?: boolean
}

type PendingRelease =
  | {
      type: 'report'
      sendInput: (data: string) => void
      getCurrentFlags: () => number
      layoutCharacterForCode?: (code: string, shifted: boolean) => string | undefined
      primaryCodePoint: number
      ignoreLockModifiers: boolean
    }
  | { type: 'consumeNativeDeadKey' }

/** Identifies a physical key so its keyup settles the release armed by its press. */
function keyIdentity(event: Pick<OptionKeyboardEvent, 'key' | 'code'>): string {
  return event.code || event.key
}

/** Drops CapsLock/NumLock from the event when the armed press was encoded without them. */
function withoutLockModifiers(event: OptionKeyboardEvent, ignore: boolean): OptionKeyboardEvent {
  return ignore ? withoutKittyLockModifiers(event) : event
}

/**
 * Tracks keydowns Orca encoded itself (bypassing xterm) so the matching keyup sends exactly one
 * kitty release when the app asked for event types, and consumes native dead-key keyups.
 */
export function createTerminalOptionKittyReleaseTracker(): {
  arm: (
    event: OptionKeyboardEvent,
    release: TerminalOptionKittyRelease,
    sendInput: (data: string) => void,
    getCurrentFlags: () => number,
    layoutCharacterForCode?: (code: string, shifted: boolean) => string | undefined
  ) => void
  armNativeDeadKey: (event: OptionKeyboardEvent) => void
  settle: (event: OptionKeyboardEvent) => boolean
  clear: () => void
} {
  const pending = new Map<string, PendingRelease>()
  const armPending = (event: OptionKeyboardEvent, release: PendingRelease): void => {
    const id = keyIdentity(event)
    if (event.repeat !== true || !pending.has(id)) {
      pending.set(id, release)
    }
  }
  return {
    arm: (event, release, sendInput, getCurrentFlags, layoutCharacterForCode) => {
      if ((release.flags & KITTY_REPORT_EVENT_TYPES) === 0) {
        return
      }
      const ignoreLockModifiers = release.ignoreLockModifiers === true
      const primaryCodePoint = resolveTerminalKittyPrimaryCodePoint(
        withoutLockModifiers(event, ignoreLockModifiers),
        {
          layoutCharacterForCode,
          primaryCharacterFallback: optionKittyPrimaryCharacterFallback(event)
        }
      )
      if (primaryCodePoint === undefined) {
        return
      }
      armPending(event, {
        type: 'report',
        sendInput,
        getCurrentFlags,
        layoutCharacterForCode,
        primaryCodePoint,
        ignoreLockModifiers
      })
    },
    armNativeDeadKey: (event) => armPending(event, { type: 'consumeNativeDeadKey' }),
    settle: (event) => {
      const id = keyIdentity(event)
      const record = pending.get(id)
      if (!record) {
        return false
      }
      pending.delete(id)
      if (record.type === 'consumeNativeDeadKey') {
        return true
      }
      const flags = record.getCurrentFlags()
      if ((flags & KITTY_REPORT_EVENT_TYPES) !== 0) {
        const data = encodeTerminalOptionKittyEvent(
          withoutLockModifiers(event, record.ignoreLockModifiers),
          {
            flags,
            type: 'release',
            layoutCharacterForCode: record.layoutCharacterForCode,
            primaryCharacterFallback: optionKittyPrimaryCharacterFallback(event),
            primaryCodePoint: record.primaryCodePoint
          }
        )
        if (data) {
          record.sendInput(data)
        }
      }
      return true
    },
    clear: () => pending.clear()
  }
}
