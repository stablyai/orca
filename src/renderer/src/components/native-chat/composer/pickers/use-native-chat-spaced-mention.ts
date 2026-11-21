import { useCallback, useMemo, useState } from 'react'
import {
  nativeChatRoomNameEquals,
  nativeChatRoomNameMatches
} from '../../../../../../shared/native-chat/input/native-chat-room-mentions'
import type { NativeChatComposerRoom } from '../native-chat-composer-types'

/** A member's name has spaces the `@` trigger can't hold: the text after `@` keeps the list open while
 *  it still names one, until Esc. */
export function useSpacedMemberQuery(
  room: NativeChatComposerRoom | null | undefined,
  draft: string,
  caret: number
): { query: string; from: number; dismiss: () => void } | null {
  const [dismissed, setDismissed] = useState<string | null>(null)
  const found = draft.slice(0, caret).match(/(?:^|\s)@(\S[^@\n]*)$/)
  const query = found?.[1]
  const from = query === undefined ? -1 : caret - query.length - 1
  // Keyed by the text before the `@`, so Esc holds only for this `@`.
  const key = `${from}:${draft.slice(0, from)}`
  if (dismissed !== null && dismissed !== key) {
    setDismissed(null)
  }
  // A finished name plus space is message text; partial names still need the picker.
  const named = useMemo(
    () =>
      query !== undefined &&
      /\s/.test(query) &&
      /[\p{L}\p{N}]/u.test(query) &&
      !(
        /\s$/.test(query) &&
        room?.mentions.some((member) => nativeChatRoomNameEquals(member.name, query))
      ) &&
      room?.mentions.some((member) => nativeChatRoomNameMatches(member.name, query)) === true,
    [room, query]
  )
  const open = named && dismissed !== key
  const dismiss = useCallback(() => setDismissed(key), [key])
  return useMemo(
    () => (open && query !== undefined ? { query, from, dismiss } : null),
    [open, query, from, dismiss]
  )
}
