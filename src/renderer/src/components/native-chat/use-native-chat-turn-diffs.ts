import { useMemo } from 'react'
import type { NativeChatSubagentRow } from '../../../../shared/native-chat-transcript-projection'
import { nativeChatRowsInTranscriptOrder } from './native-chat-subagent-sections'
import { nativeChatTurnDiffs, type NativeChatTurnDiff } from './native-chat-turn-diffs'
import type { NativeChatTurnRows } from './use-native-chat-turn-membership'

const NO_TURN_DIFFS: ReadonlyMap<string, NativeChatTurnDiff> = new Map()

/** Count subagent edits in their owning turn; omit totals without a journal or for partially loaded turns. */
export function useNativeChatTurnDiffs(
  turns: NativeChatTurnRows | null,
  subagentRows: readonly NativeChatSubagentRow[],
  subagentSectionsOf: ReadonlyMap<string, readonly string[]>
): ReadonlyMap<string, NativeChatTurnDiff> {
  return useMemo(() => {
    if (!turns) {
      return NO_TURN_DIFFS
    }
    const merged = nativeChatRowsInTranscriptOrder(turns.messages, turns.turnKeys, subagentRows)
    return nativeChatTurnDiffs(
      merged.messages,
      merged.turnKeys,
      subagentSectionsOf,
      turns.partialTurnKey
    )
  }, [subagentRows, subagentSectionsOf, turns])
}
