import { KITTY_REPORT_EVENT_TYPES } from '../../../../shared/terminal-kitty-keyboard-flags'
import {
  encodeTerminalOptionKittyEvent,
  optionKittyPrimaryCharacterFallback,
  resolveTerminalKittyPrimaryCodePoint
} from './terminal-kitty-csi-u-encoding'

export type TerminalOptionKittyRelease = { flags: number }

type OptionKeyboardEvent = {
  key: string
  code?: string
  shiftKey: boolean
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  repeat?: boolean
  getModifierState?: (key: string) => boolean
}

type PendingRelease =
  | {
      type: 'report'
      sendInput: (data: string) => void
      getCurrentFlags: () => number
      layoutCharacterForCode?: (code: string, shifted: boolean) => string | undefined
      primaryCodePoint: number
    }
  | { type: 'consumeNativeDeadKey' }

function keyIdentity(event: Pick<OptionKeyboardEvent, 'key' | 'code'>): string {
  return event.code || event.key
}

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
      const primaryCodePoint = resolveTerminalKittyPrimaryCodePoint(event, {
        layoutCharacterForCode,
        primaryCharacterFallback: optionKittyPrimaryCharacterFallback(event)
      })
      if (primaryCodePoint === undefined) {
        return
      }
      armPending(event, {
        type: 'report',
        sendInput,
        getCurrentFlags,
        layoutCharacterForCode,
        primaryCodePoint
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
        const data = encodeTerminalOptionKittyEvent(event, {
          flags,
          type: 'release',
          layoutCharacterForCode: record.layoutCharacterForCode,
          primaryCharacterFallback: optionKittyPrimaryCharacterFallback(event),
          primaryCodePoint: record.primaryCodePoint
        })
        if (data) {
          record.sendInput(data)
        }
      }
      return true
    },
    clear: () => pending.clear()
  }
}
