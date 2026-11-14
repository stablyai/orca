import { useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { readStructuredAgentSessionItem } from '@/runtime/native-chat/journal/structured-agent-session-journal-reads'
import { structuredAgentSessionHostCapabilityState } from '@/runtime/native-chat/host-capabilities/structured-agent-session-host-support'
import { AGENT_SESSION_ITEM_DETAIL_RUNTIME_CAPABILITY } from '../../../../../../shared/agent-session/agent-session-runtime-capabilities'
import type { NativeChatSubagentRow } from '../../../../../../shared/native-chat/transcript/native-chat-transcript-projection'
import {
  nativeChatTurnOpenedPullRequests,
  type NativeChatOpenedPullRequestsCache,
  type NativeChatTurnOpenedPullRequests
} from '../../../../../../shared/native-chat/tools/native-chat-opened-pull-requests'
import { nativeChatToolFullPayload } from '../../../../../../shared/native-chat/tools/native-chat-tool-output'
import { nativeChatRowsInTranscriptOrder } from '../../subagents/native-chat-subagent-scope'
import { NativeChatMarkdownImageOwnerContext } from '../../media/images/native-chat-markdown-image-owner'
import { useNativeChatVisualOwner } from '../../media/visuals/native-chat-visual-owner'
import type { NativeChatTurnRows } from '../../conversation/slots/use-native-chat-turn-membership'

const NONE: NativeChatTurnOpenedPullRequests = {
  byTurn: new Map(),
  clippedCreateOutputs: [],
  latestChangeKey: undefined
}
const NO_FULL_OUTPUTS: ReadonlyMap<string, string | null> = new Map()
// Per message, for one set of whole outputs: a streaming reply rescans only the rows it changed.
const evidenceCaches = new WeakMap<
  ReadonlyMap<string, string | null>,
  NativeChatOpenedPullRequestsCache
>()

function evidenceCacheFor(
  fullOutputs: ReadonlyMap<string, string | null>
): NativeChatOpenedPullRequestsCache {
  let cache = evidenceCaches.get(fullOutputs)
  if (!cache) {
    cache = new WeakMap()
    evidenceCaches.set(fullOutputs, cache)
  }
  return cache
}

// An output its host couldn't give yet is asked again, each on its own backoff, while shown.
const FULL_OUTPUT_RETRY_BASE_MS = 10_000
const FULL_OUTPUT_RETRY_MAX_MS = 5 * 60_000

type FullOutputRetry = { failures: number; dueAt: number }

/** Pull requests each turn opened, counting subagents' commands in their owning turn. A create
 *  call whose output reached the chat cut short is decided once its host gives it whole; only a
 *  host that answered it can't falls back to the head. */
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
  const opened = useMemo(() => {
    if (!enabled || !turns) {
      return NONE
    }
    const merged = nativeChatRowsInTranscriptOrder(turns.messages, turns.turnKeys, subagentRows)
    const found = nativeChatTurnOpenedPullRequests(merged.messages, merged.turnKeys, {
      partialTurnKey: turns.partialTurnKey,
      fullOutputs: ownedOutputs,
      cache: evidenceCacheFor(ownedOutputs)
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
  // A hidden chat reads nothing; what is still pending is asked again when it is shown.
  const chatVisible = useContext(NativeChatMarkdownImageOwnerContext)?.isVisible ?? true
  // Transient: which outputs failed and when each may be asked again; never decides a card.
  const retries = useRef(new Map<string, FullOutputRetry>())
  const [wake, setWake] = useState(0)
  useEffect(() => {
    // Until the chat's owner is known there is no host to ask; its outputs stay pending.
    if (!owner || !clippedKey || !chatVisible) {
      return
    }
    const ownerKey = `${JSON.stringify(owner.target)}:${owner.sessionId}`
    const ids = clippedKey.split('\n')
    const keyOf = (id: string): string => `${ownerKey}\n${id}`
    const live = new Set(ids.map(keyOf))
    for (const key of retries.current.keys()) {
      if (!live.has(key)) {
        retries.current.delete(key)
      }
    }
    const failed = (id: string): void => {
      const failures = (retries.current.get(keyOf(id))?.failures ?? 0) + 1
      const delay = Math.min(
        FULL_OUTPUT_RETRY_BASE_MS * 2 ** (failures - 1),
        FULL_OUTPUT_RETRY_MAX_MS
      )
      retries.current.set(keyOf(id), { failures, dueAt: Date.now() + delay })
    }
    const due = ids.filter((id) => (retries.current.get(keyOf(id))?.dueAt ?? 0) <= Date.now())
    let cancelled = false
    let timer: number | undefined
    void (async () => {
      const answered = new Map<string, string | null>()
      if (due.length > 0) {
        const capability = await structuredAgentSessionHostCapabilityState(
          owner.target,
          AGENT_SESSION_ITEM_DETAIL_RUNTIME_CAPABILITY
        )
        if (capability === 'unsupported') {
          // An older host can't give outputs whole; decide from the heads it sent.
          for (const id of due) {
            answered.set(id, null)
          }
        } else if (capability === 'unknown') {
          if (cancelled) {
            return
          }
          due.forEach(failed)
        } else {
          for (const id of due) {
            if (cancelled) {
              return
            }
            try {
              const item = await readStructuredAgentSessionItem(owner.target, owner.sessionId, id)
              const payload = item?.itemId === id ? nativeChatToolFullPayload(item.body) : null
              // The host answered without that output, so it is gone; the head is all there is.
              answered.set(id, payload?.head ?? null)
            } catch {
              // A run the chat has moved past leaves the retry state to the run that replaced it.
              if (cancelled) {
                return
              }
              failed(id)
            }
          }
        }
      }
      if (cancelled) {
        return
      }
      if (answered.size > 0) {
        setFullOutputs((held) => ({
          owner,
          outputs: new Map([...(held.owner === owner ? held.outputs : []), ...answered])
        }))
      }
      const next = ids
        .filter((id) => !answered.has(id))
        .map((id) => retries.current.get(keyOf(id))?.dueAt)
        .filter((dueAt): dueAt is number => dueAt !== undefined)
      if (next.length > 0) {
        timer = window.setTimeout(
          () => setWake((value) => value + 1),
          Math.max(0, Math.min(...next) - Date.now())
        )
      }
    })()
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [chatVisible, clippedKey, owner, wake])
  return opened
}
