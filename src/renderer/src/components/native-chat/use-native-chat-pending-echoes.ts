import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { claimBootstrapPendingSends } from './native-chat-pending-conversation'
import {
  appendCommandMarkerCache,
  appendPendingSendCache,
  nextNativeChatPendingSendId,
  prunePendingSends,
  readCommandMarkerCache,
  readPendingSendCache,
  writePendingSendCache,
  type NativeChatCommandMarker,
  type NativeChatPendingSend
} from './native-chat-pending'

export type NativeChatPendingEchoesInput = {
  paneKey: string
  agent: string
  /** The pane's conversation identity — the agent's provider session id, or
   *  null before it has reported one. */
  sessionId: string | null
  /** The conversation as currently rendered, used to retire matched echoes. */
  messages: NativeChatMessage[]
}

export type NativeChatPendingEchoes = {
  pending: NativeChatPendingSend[]
  commandMarkers: NativeChatCommandMarker[]
  /** Records the echo and returns its id so the send lifecycle can cancel it. */
  onOptimisticSend: (text: string, imagePaths?: string[]) => string
  onOptimisticSendCanceled: (pendingId: string) => void
  onSlashCommand: (command: string) => void
  /** Drops every echo for the live conversation (composer Stop). */
  clearPendingSends: () => void
}

/**
 * Optimistic "queued" composer echoes for one pane, scoped to the conversation
 * they were sent into.
 *
 * The cache key carries the conversation id, so replacing the pane's
 * conversation (`/clear`, an agent restart, resuming a different session) moves
 * the pane to a different key and the predecessor's echoes are unreachable —
 * they can no longer be read, rendered, or written back. Only the pre-identity
 * window needs a rule, and `claimBootstrapPendingSends` owns it.
 */
export function useNativeChatPendingEchoes({
  paneKey,
  agent,
  sessionId,
  messages
}: NativeChatPendingEchoesInput): NativeChatPendingEchoes {
  const pendingScope = useMemo(
    () => ({ paneKey, agent, conversationId: sessionId }),
    [paneKey, agent, sessionId]
  )
  // Slash commands aren't chat turns, so they get a small local "Ran /clear"
  // system line instead of a user bubble. Capped + cached per conversation.
  const commandMarkerScope = useMemo(
    () => ({ paneKey, agent, sessionId }),
    [paneKey, agent, sessionId]
  )
  const [pending, setPending] = useState<NativeChatPendingSend[]>(() =>
    readPendingSendCache(pendingScope)
  )
  const renderedPendingScope = useRef(pendingScope)
  // A conversation replacement must not render its predecessor even once
  // before the commit-phase cache handoff resets local state.
  const scopedPending = renderedPendingScope.current === pendingScope ? pending : []
  const [commandMarkers, setCommandMarkers] = useState<NativeChatCommandMarker[]>(() =>
    readCommandMarkerCache(commandMarkerScope)
  )

  useLayoutEffect(() => {
    // Why: the claim has to run before the read, or the first render after the
    // agent reports its session id sees an empty bucket and flashes the empty
    // state while the pre-identity echo is still waiting for its real turn.
    // Markers come from the pre-identity marker scope because that is where a
    // `/clear` typed in the same window was recorded.
    claimBootstrapPendingSends(
      pendingScope,
      readCommandMarkerCache({ paneKey, agent, sessionId: null })
    )
    renderedPendingScope.current = pendingScope
    setPending(readPendingSendCache(pendingScope))
  }, [pendingScope, paneKey, agent])
  useEffect(() => {
    setCommandMarkers(readCommandMarkerCache(commandMarkerScope))
  }, [commandMarkerScope])
  // Retire echoes whose real user turn is now in the transcript. Runs after the
  // reset effect above, so its `prev` is already the live conversation's list.
  useEffect(() => {
    setPending((prev) => writePendingSendCache(pendingScope, prunePendingSends(prev, messages)))
  }, [messages, pendingScope])

  const onOptimisticSend = useCallback(
    (text: string, imagePaths?: string[]) => {
      const sentAt = Date.now()
      const boundary = messages.at(-1)
      const entry: NativeChatPendingSend = {
        id: nextNativeChatPendingSendId(sentAt),
        text,
        sentAt,
        afterMessageId: boundary?.id ?? null,
        afterMessageTimestamp: boundary?.timestamp ?? null,
        ...(imagePaths ? { imagePaths } : {})
      }
      setPending(appendPendingSendCache(pendingScope, entry))
      return entry.id
    },
    [pendingScope, messages]
  )
  const onOptimisticSendCanceled = useCallback(
    (pendingId: string) => {
      // Why: detach/interrupt cancels the delayed Enter, so its optimistic echo
      // must not come back from the pane cache as a prompt that was delivered.
      const next = readPendingSendCache(pendingScope).filter((entry) => entry.id !== pendingId)
      setPending(writePendingSendCache(pendingScope, next))
    },
    [pendingScope]
  )
  const onSlashCommand = useCallback(
    (command: string) => {
      setCommandMarkers(appendCommandMarkerCache(commandMarkerScope, command))
    },
    [commandMarkerScope]
  )
  const clearPendingSends = useCallback(() => {
    setPending(writePendingSendCache(pendingScope, []))
  }, [pendingScope])

  return {
    pending: scopedPending,
    commandMarkers,
    onOptimisticSend,
    onOptimisticSendCanceled,
    onSlashCommand,
    clearPendingSends
  }
}
