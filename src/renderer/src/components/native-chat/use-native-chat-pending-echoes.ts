import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction
} from 'react'
import type { NativeChatMessage, NativeChatSession } from '../../../../shared/native-chat-types'
import {
  appendCommandMarkerCache,
  appendPendingSendCache,
  nextNativeChatPendingSendId,
  prunePendingSends,
  readCommandMarkerCache,
  readPendingSendCache,
  writePendingSendCache,
  type NativeChatCommandMarker,
  type NativeChatCommandMarkerScope,
  type NativeChatPendingSend
} from './native-chat-pending'
import { retainPendingSendsForConversation } from './native-chat-pending-conversation'
import { withoutNativeChatPendingOccurrence } from './native-chat-pending-occurrence'

export type NativeChatPendingEchoes = {
  pending: NativeChatPendingSend[]
  commandMarkers: NativeChatCommandMarker[]
  /** Echo a composer send and return its optimistic id. */
  recordSend: (text: string, imagePaths?: string[]) => string
  cancelSend: (pendingId: string) => void
  recordSlashCommand: (command: string) => void
  clearPending: () => void
}

/**
 * Owns the pane's locally-minted chat entries — optimistic "queued" sends
 * (mobile parity) and slash-command markers — plus the rules that retire them.
 * A send is echoed immediately and pruned once its real user turn lands in the
 * transcript, so the message never vanishes between send and transcript
 * catch-up.
 */
export function useNativeChatPendingEchoes(args: {
  paneKey: string
  agent: NativeChatSession['agent']
  sessionId: string | null
  messages: NativeChatMessage[]
  setWorkingInterrupted: Dispatch<SetStateAction<boolean>>
}): NativeChatPendingEchoes {
  const { paneKey, agent, sessionId, messages, setWorkingInterrupted } = args
  // Why: the effects below re-read pane caches, so an unstable setter in their
  // deps would loop. Keep the suppression reset behind a stable callback.
  const setWorkingInterruptedRef = useRef(setWorkingInterrupted)
  useEffect(() => {
    setWorkingInterruptedRef.current = setWorkingInterrupted
  }, [setWorkingInterrupted])
  const clearWorkingSuppression = useCallback(() => {
    setWorkingInterruptedRef.current(false)
  }, [])
  const commandMarkerScope = useMemo(
    () => ({ paneKey, agent, sessionId }),
    [paneKey, agent, sessionId]
  )
  const pendingScope = useMemo(() => ({ paneKey, agent }), [paneKey, agent])
  const [pending, setPending] = useState<NativeChatPendingSend[]>(() =>
    readPendingSendCache(pendingScope)
  )
  // Slash commands aren't chat turns, so they get a small local "Ran /clear"
  // system line instead of a user bubble. Capped + cached per conversation.
  // The scope travels with the markers: the retain effect below must be able to
  // tell that a value still describes the conversation it was read for.
  const [markerState, setMarkerState] = useState<{
    scope: NativeChatCommandMarkerScope
    markers: NativeChatCommandMarker[]
  }>(() => ({ scope: commandMarkerScope, markers: readCommandMarkerCache(commandMarkerScope) }))
  const commandMarkers = markerState.markers
  // Reset the optimistic queue only when the pane/agent changes. A fresh launch
  // often learns its provider session id after the first send; clearing pending
  // on that transition briefly flashes the empty state before the transcript
  // user turn lands.
  useEffect(() => {
    setPending(readPendingSendCache(pendingScope))
    clearWorkingSuppression()
  }, [clearWorkingSuppression, pendingScope])
  // Command markers are session-scoped because slash commands like /clear are
  // local feedback for a specific transcript boundary.
  useEffect(() => {
    setMarkerState({
      scope: commandMarkerScope,
      markers: readCommandMarkerCache(commandMarkerScope)
    })
    clearWorkingSuppression()
  }, [clearWorkingSuppression, commandMarkerScope])
  // Prune echoes whose real user turn is now in the transcript.
  useEffect(() => {
    setPending((prev) => writePendingSendCache(pendingScope, prunePendingSends(prev, messages)))
  }, [messages, pendingScope])
  // Drop echoes the pane's current conversation can never match, so a replaced
  // conversation cannot strand an old prompt as its newest bubble.
  useEffect(() => {
    // Why: moving the chat view to another leaf changes both scopes in one
    // commit, so this would otherwise run against the new pane's echoes while
    // still holding the previous pane's `/clear` — and the drop it writes to the
    // pane cache is permanent. Wait for the markers that describe this
    // conversation; the effect above delivers them in that same commit.
    if (markerState.scope !== commandMarkerScope) {
      return
    }
    setPending((prev) => {
      const next = retainPendingSendsForConversation(prev, {
        sessionId,
        markers: markerState.markers
      })
      return next === prev ? prev : writePendingSendCache(pendingScope, next)
    })
  }, [commandMarkerScope, markerState, pendingScope, sessionId])
  const recordSend = useCallback(
    (text: string, imagePaths?: string[]) => {
      clearWorkingSuppression()
      const sentAt = Date.now()
      const boundary = messages.at(-1)
      const entry: NativeChatPendingSend = {
        id: nextNativeChatPendingSendId(sentAt),
        text,
        sentAt,
        afterMessageId: boundary?.id ?? null,
        afterMessageTimestamp: boundary?.timestamp ?? null,
        sessionId,
        ...(imagePaths ? { imagePaths } : {})
      }
      setPending(appendPendingSendCache(pendingScope, entry))
      return entry.id
    },
    [clearWorkingSuppression, messages, pendingScope, sessionId]
  )
  const cancelSend = useCallback(
    (pendingId: string) => {
      // Why: detach/interrupt cancels the delayed Enter, so its optimistic echo
      // must not come back from the pane cache as a prompt that was delivered.
      // A cancelled send also consumes no transcript occurrence, so a repeat of
      // the same text queued after it must stop waiting on the slot this echo
      // would have taken.
      const cached = readPendingSendCache(pendingScope)
      const removedIndex = cached.findIndex((entry) => entry.id === pendingId)
      const next =
        removedIndex < 0 ? cached : withoutNativeChatPendingOccurrence(cached, removedIndex)
      setPending(writePendingSendCache(pendingScope, next))
    },
    [pendingScope]
  )
  const recordSlashCommand = useCallback(
    (command: string) => {
      setMarkerState({
        scope: commandMarkerScope,
        markers: appendCommandMarkerCache(commandMarkerScope, command)
      })
    },
    [commandMarkerScope]
  )
  const clearPending = useCallback(() => {
    setPending(writePendingSendCache(pendingScope, []))
  }, [pendingScope])
  return { pending, commandMarkers, recordSend, cancelSend, recordSlashCommand, clearPending }
}
