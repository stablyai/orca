import { useMemo } from 'react'
import type { NativeChatSubagentRow } from '../../../../../../shared/native-chat/transcript/native-chat-transcript-projection'
import { nativeChatRowsInTranscriptOrder } from '../../subagents/native-chat-subagent-scope'
import {
  nativeChatTurnDiffs,
  type NativeChatTurnDiff
} from '../../../../../../shared/native-chat/tools/native-chat-turn-diffs'
import type { NativeChatTurnRows } from '../../conversation/slots/use-native-chat-turn-membership'

const NO_TURN_DIFFS: ReadonlyMap<string, NativeChatTurnDiff> = new Map()

/** Count subagent edits in their owning turn; omit totals without a journal or for partially loaded turns. */
export function useNativeChatTurnDiffs(
  turns: NativeChatTurnRows | null,
  subagentRows: readonly NativeChatSubagentRow[]
): ReadonlyMap<string, NativeChatTurnDiff> {
  // Edits never live in reply text, so a reply that only streams leaves the totals as they were.
  const messages = turns ? (turns.structureMessages ?? turns.messages) : null
  const turnKeys = turns?.turnKeys
  const partialTurnKey = turns?.partialTurnKey
  return useMemo(() => {
    if (!messages || !turnKeys) {
      return NO_TURN_DIFFS
    }
    const merged = nativeChatRowsInTranscriptOrder(messages, turnKeys, subagentRows)
    return nativeChatTurnDiffs(merged.messages, merged.turnKeys, undefined, partialTurnKey)
  }, [messages, partialTurnKey, subagentRows, turnKeys])
}
