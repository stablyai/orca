import type {
  RuntimeSessionTabChatView,
  RuntimeSessionTabChatViewWrite
} from './runtime-session-contracts'
import type { TerminalChatPair, TerminalTabViewMode } from './terminal-tab-view-mode'

/** How long an adopted host reply may wait for a snapshot that shows it. */
export const CHAT_PAIR_PENDING_CONFIRM_MS = 5_000

/** One absolute pair write: `leafId` null addresses the parent tab. */
export type ChatPairWriteRequest = {
  viewMode: TerminalTabViewMode
  leafId: string | null
}

export type ChatPairWriteReply = {
  chatView?: RuntimeSessionTabChatView
  superseded?: true
}

export type ChatPairPendingDeps<Key> = {
  /**
   * New per client process, never persisted: sequences restart at 1 and the host keeps each
   * writer's high-water mark for the tab's lifetime, so a reused id would be refused as stale.
   */
  writerId: string
  keyId: (key: Key) => string
  /** The latest accepted host pair, or null once the parent tab is gone. */
  readHostPair: (key: Key) => TerminalChatPair | null
  send: (
    key: Key,
    request: ChatPairWriteRequest,
    write: RuntimeSessionTabChatViewWrite
  ) => Promise<ChatPairWriteReply>
  /** True when the request may have reached the host (timeout, lost connection). */
  isDeliveryUnknown: (error: unknown) => boolean
  /** Shows `pair` over the host pair for `key`; null returns the display to the host pair. */
  showPending: (key: Key, pair: TerminalChatPair | null) => void
  reportFailure: (key: Key, error: unknown) => void
  setTimer: (callback: () => void, ms: number) => unknown
  clearTimer: (handle: unknown) => void
}

export type ChatPairPendingWrites<Key> = {
  /** Shows `target` at once and sends the write with the next sequence number. */
  submit: (key: Key, request: ChatPairWriteRequest, target: TerminalChatPair) => number
  /** Call after every applied host snapshot: retires an adopted reply the host now shows. */
  hostPairChanged: (key: Key) => void
  /** Forgets the entry without reporting; the display returns to the host pair. */
  drop: (key: Key) => void
  pendingKeys: () => Key[]
  pendingPair: (key: Key) => TerminalChatPair | null
}

type Entry<Key> = {
  key: Key
  seq: number
  request: ChatPairWriteRequest
  target: TerminalChatPair
  /** The host pair when the write was sent; it may predate this client's earlier unconfirmed write. */
  hostAtSubmit: TerminalChatPair | null
  retried: boolean
  deadline: unknown
}

export function chatPairsEqual(a: TerminalChatPair, b: TerminalChatPair): boolean {
  return (
    (a.viewMode ?? null) === (b.viewMode ?? null) &&
    (a.chatLeafId ?? null) === (b.chatLeafId ?? null)
  )
}

/**
 * True once the host shows `entry.target`. A chat naming no pane is shown by a host chat on any
 * pane, but only once the host pair has changed since the write: the pair seen at send time can
 * still predate this client's earlier write.
 */
function hostShowsTarget<Key>(host: TerminalChatPair, entry: Entry<Key>): boolean {
  const { target, hostAtSubmit } = entry
  if (chatPairsEqual(host, target)) {
    return true
  }
  return (
    target.viewMode === 'chat' &&
    !target.chatLeafId &&
    host.viewMode === 'chat' &&
    (hostAtSubmit === null || !chatPairsEqual(host, hostAtSubmit))
  )
}

export function chatPairFromChatView(view: RuntimeSessionTabChatView): TerminalChatPair {
  return {
    ...(view.viewMode ? { viewMode: view.viewMode } : {}),
    ...(view.chatLeafId ? { chatLeafId: view.chatLeafId } : {})
  }
}

export class ChatPairReplyMissingError extends Error {
  constructor() {
    super('The host reply did not carry the applied chat view.')
    this.name = 'ChatPairReplyMissingError'
  }
}

/**
 * Pending chat-pair writes for one client process. Every write is sent at once with a fresh
 * sequence number and the host orders them; only the latest write per key decides the overlay.
 */
export function createChatPairPendingWrites<Key>(
  deps: ChatPairPendingDeps<Key>
): ChatPairPendingWrites<Key> {
  const entries = new Map<string, Entry<Key>>()
  // Why never reset: one counter spans entries, drops and transports, so a seq is never reused.
  let lastSeq = 0

  const current = (id: string, seq: number): Entry<Key> | null => {
    const entry = entries.get(id)
    return entry && entry.seq === seq ? entry : null
  }

  const remove = (id: string, entry: Entry<Key>): void => {
    if (entry.deadline !== null) {
      deps.clearTimer(entry.deadline)
    }
    entries.delete(id)
    deps.showPending(entry.key, null)
  }

  const complete = (id: string, seq: number, reply: ChatPairWriteReply): void => {
    const entry = current(id, seq)
    if (!entry) {
      return
    }
    if (!reply.chatView) {
      remove(id, entry)
      deps.reportFailure(entry.key, new ChatPairReplyMissingError())
      return
    }
    // Why adopt: the host normalizes (parent chat keeps its owner; a refused write names the current pair).
    entry.target = chatPairFromChatView(reply.chatView)
    const host = deps.readHostPair(entry.key)
    if (!host || hostShowsTarget(host, entry)) {
      remove(id, entry)
      return
    }
    deps.showPending(entry.key, entry.target)
    entry.deadline = deps.setTimer(() => {
      const expiring = current(id, seq)
      if (expiring) {
        remove(id, expiring)
      }
    }, CHAT_PAIR_PENDING_CONFIRM_MS)
  }

  const fail = (id: string, seq: number, error: unknown): void => {
    const failing = current(id, seq)
    if (failing) {
      remove(id, failing)
      deps.reportFailure(failing.key, error)
    }
  }

  const dispatch = (id: string, entry: Entry<Key>): void => {
    const { seq } = entry
    new Promise<ChatPairWriteReply>((resolve) => {
      resolve(deps.send(entry.key, entry.request, { writerId: deps.writerId, seq }))
    }).then(
      (reply) => {
        // Why catch: a throw here (a non-object reply, a throwing subscriber) would leave the entry with no deadline.
        try {
          complete(id, seq, reply)
        } catch (error) {
          fail(id, seq, error)
        }
      },
      (error: unknown) => {
        const failing = current(id, seq)
        // Why the same seq: it is still this key's latest write, so the host fence makes a resend idempotent.
        if (failing && deps.isDeliveryUnknown(error) && !failing.retried) {
          failing.retried = true
          dispatch(id, failing)
          return
        }
        fail(id, seq, error)
      }
    )
  }

  return {
    submit: (key, request, target) => {
      const id = deps.keyId(key)
      const previous = entries.get(id)
      if (previous && previous.deadline !== null) {
        deps.clearTimer(previous.deadline)
      }
      lastSeq += 1
      const entry: Entry<Key> = {
        key,
        seq: lastSeq,
        request,
        target,
        hostAtSubmit: deps.readHostPair(key),
        retried: false,
        deadline: null
      }
      entries.set(id, entry)
      deps.showPending(key, target)
      dispatch(id, entry)
      return entry.seq
    },
    hostPairChanged: (key) => {
      const id = deps.keyId(key)
      const entry = entries.get(id)
      // Why only after the reply: before it, a snapshot can still show an older write's result.
      if (!entry || entry.deadline === null) {
        return
      }
      const host = deps.readHostPair(key)
      if (!host || hostShowsTarget(host, entry)) {
        remove(id, entry)
      }
    },
    drop: (key) => {
      const id = deps.keyId(key)
      const entry = entries.get(id)
      if (entry) {
        remove(id, entry)
      }
    },
    pendingKeys: () => [...entries.values()].map((entry) => entry.key),
    pendingPair: (key) => entries.get(deps.keyId(key))?.target ?? null
  }
}
