// Which replies an open transcript is still drawing, and how far each has got.

import type { NativeChatTextReveal } from './native-chat-text-reveal'

/** Per-transcript reveal state: legacy live-row keys repeat across chats. */
export type NativeChatReplyReveals = {
  /** Tail replies first seen while the transcript was open; exclude history already written before opening. */
  begun: Set<string>
  /** How much of a row was drawn when it left the window, so returning does not replay it. */
  drawn: Map<string, NativeChatTextReveal>
}

export type NativeChatReplyRevealTracker = {
  reveals: NativeChatReplyReveals
  rowKeys: readonly string[]
  loadedMessageIds: ReadonlySet<string> | null
  known: Set<string>
}

export function createNativeChatReplyRevealTracker(): NativeChatReplyRevealTracker {
  return {
    reveals: { begun: new Set(), drawn: new Map() },
    rowKeys: [],
    loadedMessageIds: null,
    known: new Set()
  }
}

/** Update once per row/message change during render so first paint sees correct reveal state; idempotent. */
export function trackNativeChatReplyRows(
  state: NativeChatReplyRevealTracker,
  rowKeys: readonly string[],
  loadedMessageIds: ReadonlySet<string>
): NativeChatReplyReveals {
  if (state.rowKeys !== rowKeys || state.loadedMessageIds !== loadedMessageIds) {
    const present = new Set(rowKeys)
    const lastKey = rowKeys.at(-1)
    const { begun, drawn } = state.reveals
    // Progress belongs to the row that made it: a later row carrying the key starts its own.
    for (const key of [...begun, ...drawn.keys()]) {
      if (!present.has(key)) {
        begun.delete(key)
        drawn.delete(key)
      }
    }
    // Remember loaded rows across section collapse/reopen so returning history cannot begin a new reveal.
    if (lastKey !== undefined && !state.known.has(lastKey) && state.known.size > 0) {
      begun.add(lastKey)
    }
    // Only message rows reveal, and only loaded ones can return, so nothing else is kept.
    for (const key of state.known) {
      if (!loadedMessageIds.has(key)) {
        state.known.delete(key)
      }
    }
    for (const key of rowKeys) {
      state.known.add(key)
    }
    state.rowKeys = rowKeys
    state.loadedMessageIds = loadedMessageIds
  }
  return state.reveals
}
