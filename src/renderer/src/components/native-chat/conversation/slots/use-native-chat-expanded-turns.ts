import { useCallback, useState } from 'react'
import { toggleNativeChatExpandedKey } from '../../messages/disclosure/native-chat-expanded-keys'
import { nativeChatFoldedTurnOf } from './native-chat-transcript-slot-selection'
import type { NativeChatTranscriptSlot } from './native-chat-transcript-slots'

/** The turns the reader expanded, and a toggle for one. */
export function useNativeChatExpandedTurns(): {
  expandedTurnIds: ReadonlySet<string>
  toggleExpandedTurn: (turnKey: string) => void
  expandTurn: (turnKey: string) => void
} {
  const [expandedTurnIds, setExpandedTurnIds] = useState<ReadonlySet<string>>(new Set())
  const toggleExpandedTurn = useCallback((turnKey: string) => {
    setExpandedTurnIds((current) => toggleNativeChatExpandedKey(current, turnKey))
  }, [])
  const expandTurn = useCallback((turnKey: string) => {
    setExpandedTurnIds((current) => new Set(current).add(turnKey))
  }, [])
  return { expandedTurnIds, toggleExpandedTurn, expandTurn }
}

/** Expands the collapsed turn that hides a loaded message; false when no turn hides it. */
export function useNativeChatUnfoldTurnOf(
  slots: readonly NativeChatTranscriptSlot[],
  messages: readonly { id: string }[],
  turnKeys: readonly (string | undefined)[],
  { expandedTurnIds, expandTurn }: ReturnType<typeof useNativeChatExpandedTurns>
): (messageId: string) => boolean {
  return useCallback(
    (messageId: string) => {
      const turnKey = nativeChatFoldedTurnOf(slots, messages, turnKeys, expandedTurnIds, messageId)
      if (turnKey !== undefined) {
        expandTurn(turnKey)
      }
      return turnKey !== undefined
    },
    [expandTurn, expandedTurnIds, messages, slots, turnKeys]
  )
}
