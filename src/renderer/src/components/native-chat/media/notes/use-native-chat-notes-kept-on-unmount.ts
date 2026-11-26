import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import type { NativeChatMediaNote } from './native-chat-media-notes'
import { holdNativeChatNotes } from './native-chat-held-notes'

type Kept = {
  notes: readonly NativeChatMediaNote[]
  /** Only new notes: a reopened marked image keeps its notes on its chip. */
  keep: boolean
  scopeKey: string | undefined
  mediaKey: string
}

/** A viewer can go away without closing: the message row that owns it scrolls out of a long chat
 *  and unmounts. New notes it still holds are kept with the chat and media, as Close keeps them
 *  when the message box can't take them, so reopening the media brings them back.
 *
 *  `settle` marks an ordinary close or a hand-off that delivered the notes, after which nothing is
 *  kept. While a hand-off is in flight (`begin` … `end`), going away keeps nothing yet: the hand-off
 *  owns the notes, and only if it then fails are they kept, so delivered notes are never held and
 *  sent again. */
export function useNativeChatNotesKeptOnUnmount(args: Kept): {
  settle: () => void
  begin: () => void
  end: (delivered: boolean) => void
} {
  const latest = useRef(args)
  const state = useRef({ settled: false, inFlight: false, goneInFlight: false })
  useLayoutEffect(() => {
    latest.current = args
  })
  useEffect(
    () => () => {
      const current = state.current
      if (current.inFlight) {
        current.goneInFlight = true
      } else if (!current.settled) {
        keep(latest.current)
      }
    },
    []
  )
  return useMemo(
    () => ({
      settle: () => {
        state.current.settled = true
      },
      begin: () => {
        state.current.inFlight = true
      },
      end: (delivered) => {
        const current = state.current
        current.inFlight = false
        if (delivered) {
          current.settled = true
        } else if (current.goneInFlight && !current.settled) {
          keep(latest.current)
        }
      }
    }),
    []
  )
}

function keep({ notes, keep: keepNew, scopeKey, mediaKey }: Kept): void {
  if (keepNew && notes.length > 0 && scopeKey) {
    holdNativeChatNotes(scopeKey, mediaKey, notes)
  }
}
