import type { SessionOptionDescriptor } from '../native-chat-session-options'
import { setBoundedScopeCacheEntry } from '../composer/native-chat-scope-cache'
import type { NativeChatPtySessionOptionsSurface } from './native-chat-pty-session-options'
import {
  markNativeChatTurnOptionPicks,
  NO_NATIVE_CHAT_TURN_OPTION_PICKS,
  takesNativeChatTurnOptionPick,
  withNativeChatTurnOptionPick,
  type NativeChatTurnOptionPicks
} from './native-chat-turn-option-picks'

// Per chat, so a surface rebuilt mid-turn keeps the picks; leaving the chat drops them.
const heldPicksByScope = new Map<string, NativeChatTurnOptionPicks>()
// Counts drops per chat, so a surface still showing or sending dropped picks lets them go.
const dropsByScope = new Map<string, number>()

export function dropNativeChatTurnHeldOptionPicks(scopeKey: string): void {
  heldPicksByScope.delete(scopeKey)
  setBoundedScopeCacheEntry(dropsByScope, scopeKey, (dropsByScope.get(scopeKey) ?? 0) + 1)
}

export type NativeChatTurnHeldOptionSurface = NativeChatPtySessionOptionsSurface & {
  /** Idle sends the held picks once, model first, through the surface's own commands. */
  setWorking(working: boolean): void
  /** The held pick being typed after the turn; its command waits for queued messages. */
  sendingHeldPick(): string | null
}

function withoutMidTurnActions(snapshot: SessionOptionDescriptor[]): SessionOptionDescriptor[] {
  return snapshot.map((descriptor) =>
    descriptor.action && descriptor.settable ? { ...descriptor, settable: false } : descriptor
  )
}

function modelFirst(picks: NativeChatTurnOptionPicks): string[] {
  return [...picks.keys()].sort(
    (left, right) => Number(right === 'model') - Number(left === 'model')
  )
}

/** A terminal agent reads typed option commands as input, so picks made mid-turn wait for the turn to end. */
export function holdNativeChatOptionPicksDuringTurns(args: {
  surface: NativeChatPtySessionOptionsSurface
  scopeKey: string
  onHeldPickFailed?: (error: unknown) => void
}): NativeChatTurnHeldOptionSurface {
  const { surface: inner, scopeKey } = args
  let working = false
  let sending: NativeChatTurnOptionPicks = NO_NATIVE_CHAT_TURN_OPTION_PICKS
  const listeners = new Set<(snapshot: SessionOptionDescriptor[]) => void>()
  const held = (): NativeChatTurnOptionPicks =>
    heldPicksByScope.get(scopeKey) ?? NO_NATIVE_CHAT_TURN_OPTION_PICKS
  const setHeld = (picks: NativeChatTurnOptionPicks): void => {
    if (picks.size === 0) {
      heldPicksByScope.delete(scopeKey)
    } else {
      setBoundedScopeCacheEntry(heldPicksByScope, scopeKey, picks)
    }
  }
  const build = (): SessionOptionDescriptor[] => {
    const shown = markNativeChatTurnOptionPicks(
      markNativeChatTurnOptionPicks(inner.getSnapshot(), sending, 'sending'),
      held(),
      'held'
    )
    return working ? withoutMidTurnActions(shown) : shown
  }
  const drops = (): number => dropsByScope.get(scopeKey) ?? 0
  let seenDrops = drops()
  // True once when the chat was left since last seen; its sending picks go with it.
  const tookDrop = (): boolean => {
    if (drops() === seenDrops) {
      return false
    }
    seenDrops = drops()
    sending = NO_NATIVE_CHAT_TURN_OPTION_PICKS
    return true
  }
  let snapshot = build()
  const publish = (): SessionOptionDescriptor[] => {
    snapshot = build()
    for (const listener of listeners) {
      listener(snapshot)
    }
    return snapshot
  }
  inner.subscribe(publish)

  const settleSending = (id: string): void => {
    const next = new Map(sending)
    next.delete(id)
    sending = next
  }
  const sendHeld = async (picks: NativeChatTurnOptionPicks): Promise<void> => {
    for (const id of modelFirst(picks)) {
      if (tookDrop()) {
        publish()
        return
      }
      const pick = picks.get(id)
      // A direct pick after the turn already replaced this one.
      if (!pick || sending.get(id) !== pick) {
        continue
      }
      try {
        await inner.setOption(id, pick.value)
      } catch (error) {
        args.onHeldPickFailed?.(error)
      } finally {
        if (sending.get(id) === pick) {
          settleSending(id)
          publish()
        }
      }
    }
  }

  return {
    ...inner,
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    setOption: (id, value) => {
      tookDrop()
      const descriptor = inner.getSnapshot().find((row) => row.id === id)
      if (!working || !takesNativeChatTurnOptionPick(descriptor)) {
        if (held().has(id) || sending.has(id)) {
          setHeld(new Map([...held()].filter(([heldId]) => heldId !== id)))
          settleSending(id)
          publish()
        }
        return inner.setOption(id, value)
      }
      // Compared with the running value now, which a report may have changed since the first pick.
      const others = new Map([...held()].filter(([heldId]) => heldId !== id))
      setHeld(withNativeChatTurnOptionPick(others, descriptor, value))
      return Promise.resolve({ snapshot: publish() })
    },
    sendingHeldPick: () => sending.keys().next().value ?? null,
    setWorking: (next) => {
      const dropped = tookDrop()
      const picks = held()
      if (next === working && (next || picks.size === 0)) {
        if (dropped) {
          publish()
        }
        return
      }
      working = next
      if (!next && picks.size > 0) {
        setHeld(NO_NATIVE_CHAT_TURN_OPTION_PICKS)
        sending = new Map([...sending, ...picks])
        void sendHeld(picks)
      }
      publish()
    }
  }
}
