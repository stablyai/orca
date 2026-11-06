import { useContext, useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@/store'
import {
  readStructuredAgentSessionItem,
  supportsStructuredAgentSessionItemDetail
} from '@/runtime/structured-agent-session-client'
import type { NativeChatSubagentRow } from '../../../../shared/native-chat/transcript/native-chat-transcript-projection'
import {
  nativeChatTurnOpenedPullRequests,
  type NativeChatOpenedPullRequestsCache,
  type NativeChatTurnOpenedPullRequests
} from '../../../../shared/native-chat/tools/native-chat-opened-pull-requests'
import { nativeChatToolFullPayload } from '../../../../shared/native-chat/tools/native-chat-tool-output'
import { nativeChatRowsInTranscriptOrder } from './native-chat-subagent-sections'
import { NativeChatMarkdownImageOwnerContext } from './native-chat-markdown-image-owner'
import { useNativeChatVisualOwner } from './native-chat-visual-owner'
import type { NativeChatTurnRows } from './use-native-chat-turn-membership'

const NONE: NativeChatTurnOpenedPullRequests = {
  byTurn: new Map(),
  clippedCreateOutputs: [],
  latestChangeKey: undefined
}
const NO_FULL_OUTPUTS: ReadonlyMap<string, string | null> = new Map()
// A host that didn't answer is asked once more after this long, without waiting for a tab switch.
const FULL_OUTPUT_RETRY_MS = 30_000

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
    outputs: ReadonlyMap<string, string | null>
  }>({ owner, outputs: NO_FULL_OUTPUTS })
  const ownedOutputs = fullOutputs.owner === owner ? fullOutputs.outputs : NO_FULL_OUTPUTS
  // Per message, for one set of whole outputs: a streaming reply rescans only the rows it changed.
  const cache = useMemo<NativeChatOpenedPullRequestsCache>(() => new WeakMap(), [ownedOutputs])
  const opened = useMemo(() => {
    if (!enabled || !turns) {
      return NONE
    }
    const merged = nativeChatRowsInTranscriptOrder(turns.messages, turns.turnKeys, subagentRows)
    const found = nativeChatTurnOpenedPullRequests(merged.messages, merged.turnKeys, {
      partialTurnKey: turns.partialTurnKey,
      fullOutputs: ownedOutputs,
      cache
    })
    // Merge request cards need a lookup chats don't have yet; GitHub's comes first.
    const byTurn = new Map(
      [...found.byTurn]
        .map(([turnKey, list]) => [turnKey, list.filter((pr) => pr.provider === 'github')] as const)
        .filter(([, list]) => list.length > 0)
    )
    return { ...found, byTurn }
  }, [cache, enabled, ownedOutputs, subagentRows, turns])

  const clippedKey = opened.clippedCreateOutputs.join('\n')
  // A hidden chat reads nothing; a read that failed is asked again when the chat is shown.
  const chatVisible = useContext(NativeChatMarkdownImageOwnerContext)?.isVisible ?? true
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    if (!owner || !clippedKey || !chatVisible) {
      return
    }
    let cancelled = false
    let retryTimer: number | undefined
    void (async () => {
      const read = new Map<string, string | null>()
      const ids = clippedKey.split('\n')
      if (!(await supportsStructuredAgentSessionItemDetail(owner.target).catch(() => false))) {
        // An older host can't give outputs whole; decide from the heads it sent.
        if (!cancelled) {
          setFullOutputs((held) => ({
            owner,
            outputs: new Map([
              ...(held.owner === owner ? held.outputs : []),
              ...ids.map((id) => [id, null] as const)
            ])
          }))
        }
        return
      }
      let unanswered = false
      for (const itemId of ids) {
        if (cancelled) {
          return
        }
        try {
          const item = await readStructuredAgentSessionItem(owner.target, owner.sessionId, itemId)
          const payload = item?.itemId === itemId ? nativeChatToolFullPayload(item.body) : null
          // The host answered without that output, so it is gone; the head is all there is.
          read.set(itemId, payload?.head ?? null)
        } catch {
          // Unreachable host: not proof the output is empty.
          unanswered = true
        }
      }
      if (!cancelled && unanswered && retry === 0) {
        retryTimer = window.setTimeout(() => setRetry(1), FULL_OUTPUT_RETRY_MS)
      }
      if (!cancelled && read.size > 0) {
        setFullOutputs((held) => ({
          owner,
          outputs: new Map([...(held.owner === owner ? held.outputs : []), ...read])
        }))
      }
    })()
    return () => {
      cancelled = true
      window.clearTimeout(retryTimer)
    }
  }, [chatVisible, clippedKey, owner, retry])
  return opened
}
