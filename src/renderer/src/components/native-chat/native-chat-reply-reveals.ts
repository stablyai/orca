// Which replies an open transcript is still drawing, and how far each has got.

import { createContext, useState } from 'react'
import type { NativeChatTextReveal } from './native-chat-text-reveal'

/** What one open transcript knows about its replies being drawn. Per transcript, because row
 *  keys are only unique within one: a legacy preview's live row has the same key in every chat. */
export type NativeChatReplyReveals = {
  /** Rows that first appeared at the end of the transcript while it was open: replies that
   *  began while the reader was watching, not ones already written when the pane opened. */
  begun: Set<string>
  /** How much of a row was drawn when it left the window, so returning does not replay it. */
  drawn: Map<string, NativeChatTextReveal>
}

/** Absent outside a transcript: such a row neither begins nor is remembered. */
export const NativeChatReplyRevealsContext = createContext<NativeChatReplyReveals | null>(null)

/** This transcript's reveals, for the rows it has now. The same object every render. */
export function useNativeChatReplyReveals(rowKeys: readonly string[]): NativeChatReplyReveals {
  const [state] = useState<{
    reveals: NativeChatReplyReveals
    rowKeys: readonly string[]
    known: Set<string>
  }>(() => ({
    reveals: { begun: new Set(), drawn: new Map() },
    rowKeys: [],
    known: new Set()
  }))
  // In render, so a row's first draw already knows. Once per change of rows, so it is idempotent.
  if (state.rowKeys !== rowKeys) {
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
    // Known for good, so a row that leaves and returns (a section closed and reopened) is not
    // taken for a reply beginning.
    if (lastKey !== undefined && !state.known.has(lastKey) && state.known.size > 0) {
      begun.add(lastKey)
    }
    for (const key of rowKeys) {
      state.known.add(key)
    }
    state.rowKeys = rowKeys
  }
  return state.reveals
}
