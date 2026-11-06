import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@/store'
import {
  readStructuredAgentSessionItem,
  supportsStructuredAgentSessionItemDetail
} from '@/runtime/structured-agent-session-client'
import type { NativeChatSubagentRow } from '../../../../shared/native-chat/transcript/native-chat-transcript-projection'
import {
  nativeChatTurnOpenedPullRequests,
  type NativeChatTurnOpenedPullRequests
} from '../../../../shared/native-chat/tools/native-chat-opened-pull-requests'
import { nativeChatToolFullPayload } from '../../../../shared/native-chat/tools/native-chat-tool-output'
import { nativeChatRowsInTranscriptOrder } from './native-chat-subagent-sections'
import { useNativeChatVisualOwner } from './native-chat-visual-owner'
import type { NativeChatTurnRows } from './use-native-chat-turn-membership'

const NONE: NativeChatTurnOpenedPullRequests = {
  byTurn: new Map(),
  clippedCreateOutputs: [],
  latestChangeKey: undefined
}
const NO_FULL_OUTPUTS: ReadonlyMap<string, string> = new Map()

/** Pull requests each turn opened, counting subagents' commands in their owning turn. A create
 *  call whose output reached the chat cut short is read whole from its host, once. */
export function useNativeChatTurnOpenedPullRequests(
  turns: NativeChatTurnRows | null,
  subagentRows: readonly NativeChatSubagentRow[]
): NativeChatTurnOpenedPullRequests {
  const enabled = useAppStore((state) => state.settings?.nativeChatOpenedPullRequests !== false)
  const owner = useNativeChatVisualOwner()
  const [fullOutputs, setFullOutputs] = useState<{
    owner: typeof owner
    outputs: ReadonlyMap<string, string>
  }>({ owner, outputs: NO_FULL_OUTPUTS })
  const ownedOutputs = fullOutputs.owner === owner ? fullOutputs.outputs : NO_FULL_OUTPUTS
  const opened = useMemo(() => {
    if (!enabled || !turns) {
      return NONE
    }
    const merged = nativeChatRowsInTranscriptOrder(turns.messages, turns.turnKeys, subagentRows)
    const found = nativeChatTurnOpenedPullRequests(merged.messages, merged.turnKeys, {
      partialTurnKey: turns.partialTurnKey,
      fullOutputs: ownedOutputs
    })
    // Merge request cards need a lookup chats don't have yet; GitHub's comes first.
    const byTurn = new Map(
      [...found.byTurn]
        .map(([turnKey, list]) => [turnKey, list.filter((pr) => pr.provider === 'github')] as const)
        .filter(([, list]) => list.length > 0)
    )
    return { ...found, byTurn }
  }, [enabled, ownedOutputs, subagentRows, turns])

  const clippedKey = opened.clippedCreateOutputs.join('\n')
  useEffect(() => {
    if (!owner || !clippedKey) {
      return
    }
    let cancelled = false
    void (async () => {
      if (!(await supportsStructuredAgentSessionItemDetail(owner.target))) {
        return
      }
      const read = new Map<string, string>()
      for (const itemId of clippedKey.split('\n')) {
        const item = await readStructuredAgentSessionItem(
          owner.target,
          owner.sessionId,
          itemId
        ).catch(() => null)
        const payload = item?.itemId === itemId ? nativeChatToolFullPayload(item.body) : null
        // An unreadable output is remembered as empty so it is not asked for again.
        read.set(itemId, payload?.head ?? '')
      }
      if (!cancelled) {
        setFullOutputs((held) => ({
          owner,
          outputs: new Map([...(held.owner === owner ? held.outputs : []), ...read])
        }))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [clippedKey, owner])
  return opened
}
