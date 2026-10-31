import { useLayoutEffect, useMemo, useRef } from 'react'
import {
  assignNativeChatRowKeys,
  type NativeChatAssignedRows
} from '../../../../shared/native-chat-row-keys'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { nativeChatSlotKey, type NativeChatTranscriptSlot } from './native-chat-transcript-slots'

export function useNativeChatTranscriptRowKeys(
  slots: readonly NativeChatTranscriptSlot[],
  messages?: readonly NativeChatMessage[]
): { itemKeys: readonly string[]; prepending: boolean } {
  const committed = useRef<NativeChatAssignedRows | null>(null)
  const assigned = useMemo(() => {
    const rows = slots.flatMap((slot) =>
      slot.kind === 'message'
        ? [
            {
              ...slot.message,
              blocks: slot.workRun?.flatMap((member) => member.blocks) ?? slot.message.blocks
            }
          ]
        : []
    )
    const sources = messages ?? rows
    return { rows, messages: sources, ...assignNativeChatRowKeys(committed.current, rows, sources) }
  }, [slots, messages])
  useLayoutEffect(() => {
    committed.current = assigned
  }, [assigned])
  // A work run can absorb its previous head when an older page lands.
  const encodedKeys = JSON.stringify(
    slots.map((slot) =>
      slot.kind === 'message'
        ? (assigned.keyById.get(slot.message.id) ?? nativeChatSlotKey(slot))
        : nativeChatSlotKey(slot)
    )
  )
  const itemKeys = useMemo<string[]>(() => JSON.parse(encodedKeys), [encodedKeys])
  const previousFirst = committed.current?.rows[0]
  const previousKey = previousFirst && committed.current?.keyById.get(previousFirst.id)
  return { itemKeys, prepending: previousKey !== undefined && itemKeys.indexOf(previousKey) > 0 }
}
