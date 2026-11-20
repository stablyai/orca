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

/** Per chat, so a surface rebuilt while held picks are typed still sees them and waits. */
type ScopeTurn = {
  working: boolean
  sending: NativeChatTurnOptionPicks
  /** The chat's surfaces that are shown; each republishes when a pick settles. */
  shown: Set<() => void>
}
const turnsByScope = new Map<string, ScopeTurn>()

function scopeTurn(scopeKey: string): ScopeTurn {
  const existing = turnsByScope.get(scopeKey)
  if (existing) {
    return existing
  }
  const turn: ScopeTurn = {
    working: false,
    sending: NO_NATIVE_CHAT_TURN_OPTION_PICKS,
    shown: new Set()
  }
  setBoundedScopeCacheEntry(turnsByScope, scopeKey, turn)
  return turn
}

export function dropNativeChatTurnHeldOptionPicks(scopeKey: string): void {
  heldPicksByScope.delete(scopeKey)
  turnsByScope.delete(scopeKey)
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
  let turn = scopeTurn(scopeKey)
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
      markNativeChatTurnOptionPicks(inner.getSnapshot(), turn.sending, 'sending'),
      held(),
      'held'
    )
    return turn.working ? withoutMidTurnActions(shown) : shown
  }
  const drops = (): number => dropsByScope.get(scopeKey) ?? 0
  let seenDrops = drops()
  // True once when the chat was left since last seen; its sending picks go with it.
  const tookDrop = (): boolean => {
    if (drops() === seenDrops) {
      return false
    }
    seenDrops = drops()
    turn = scopeTurn(scopeKey)
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
  const publishShown = (): void => {
    publish()
    for (const republish of turn.shown) {
      if (republish !== publish) {
        republish()
      }
    }
  }

  const settleSending = (id: string): void => {
    const next = new Map(turn.sending)
    next.delete(id)
    turn.sending = next
  }
  /** A turn started before these were typed: hold them again unless a newer pick replaced them. */
  const holdAgain = (ids: readonly string[], picks: NativeChatTurnOptionPicks): void => {
    const again = new Map(held())
    for (const id of ids) {
      const pick = picks.get(id)
      if (pick && turn.sending.get(id) === pick) {
        settleSending(id)
        if (!again.has(id)) {
          again.set(id, pick)
        }
      }
    }
    setHeld(again)
  }
  const sendHeld = async (picks: NativeChatTurnOptionPicks): Promise<void> => {
    const ids = modelFirst(picks)
    for (const [index, id] of ids.entries()) {
      if (tookDrop()) {
        publishShown()
        return
      }
      if (turn.working) {
        holdAgain(ids.slice(index), picks)
        publishShown()
        return
      }
      const pick = picks.get(id)
      // A direct pick after the turn already replaced this one.
      if (!pick || turn.sending.get(id) !== pick) {
        continue
      }
      try {
        await inner.setOption(id, pick.value)
      } catch (error) {
        args.onHeldPickFailed?.(error)
      } finally {
        if (turn.sending.get(id) === pick) {
          settleSending(id)
          publishShown()
        }
      }
    }
  }

  return {
    ...inner,
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      turn.shown.add(publish)
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) {
          turn.shown.delete(publish)
        }
      }
    },
    setOption: (id, value) => {
      tookDrop()
      const descriptor = inner.getSnapshot().find((row) => row.id === id)
      if (!turn.working || !takesNativeChatTurnOptionPick(descriptor)) {
        if (held().has(id) || turn.sending.has(id)) {
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
    sendingHeldPick: () => {
      tookDrop()
      return turn.sending.keys().next().value ?? null
    },
    setWorking: (next) => {
      const dropped = tookDrop()
      const picks = held()
      if (next === turn.working && (next || picks.size === 0)) {
        if (dropped) {
          publish()
        }
        return
      }
      turn.working = next
      if (!next && picks.size > 0) {
        setHeld(NO_NATIVE_CHAT_TURN_OPTION_PICKS)
        turn.sending = new Map([...turn.sending, ...picks])
        void sendHeld(picks)
      }
      publish()
    }
  }
}
