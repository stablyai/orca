import { useEffect, useLayoutEffect, useRef } from 'react'
import type { NativeChatMediaNote } from './native-chat-media-notes'
import { holdNativeChatNotes } from './native-chat-held-notes'

/** A viewer can go away without closing: the message row that owns it scrolls out of a long chat
 *  and unmounts. New notes it still holds are kept with the chat and media, as Close keeps them
 *  when the message box can't take them, so reopening the media brings them back. `settle` marks an
 *  ordinary close or hand-off, after which nothing is kept. */
export function useNativeChatNotesKeptOnUnmount(args: {
  notes: readonly NativeChatMediaNote[]
  /** Only new notes: a reopened marked image keeps its notes on its chip. */
  keep: boolean
  scopeKey: string | undefined
  mediaKey: string
}): { settle: () => void } {
  const latest = useRef(args)
  const settled = useRef(false)
  useLayoutEffect(() => {
    latest.current = args
  })
  useEffect(
    () => () => {
      const { notes, keep, scopeKey, mediaKey } = latest.current
      if (!settled.current && keep && notes.length > 0 && scopeKey) {
        holdNativeChatNotes(scopeKey, mediaKey, notes)
      }
    },
    []
  )
  return { settle: () => (settled.current = true) }
}
