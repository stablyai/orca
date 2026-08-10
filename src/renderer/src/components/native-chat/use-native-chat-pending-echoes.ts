import {
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
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
  type NativeChatPendingSend
} from './native-chat-pending'
import { retainPendingSendsForConversation } from './native-chat-pending-conversation'
import { dropNativeChatPendingOccurrences } from './native-chat-pending-occurrence'

export type NativeChatPendingEchoes = {
  pending: NativeChatPendingSend[]
  commandMarkers: NativeChatCommandMarker[]
  /** Echo a composer send and return its optimistic id. */
  recordSend: (text: string, imagePaths?: string[]) => string
  /** Retire the echo for a send whose delayed Enter was cancelled. */
  cancelSend: (pendingId: string) => void
  /** Record a slash command as a local system line for this conversation. */
  recordSlashCommand: (command: string) => void
  /** Drop every echo in the pane, e.g. when Stop interrupts the agent. */
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
  // Why: the scope effects below re-read pane caches, so an unstable setter in
  // their deps would loop. Event handlers call the setter directly.
  const clearWorkingSuppression = useEffectEvent(() => {
    setWorkingInterrupted(false)
  })
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
  const [commandMarkers, setCommandMarkers] = useState<NativeChatCommandMarker[]>(() =>
    readCommandMarkerCache(commandMarkerScope)
  )
  // Reset the optimistic queue only when the pane/agent changes. A fresh launch
  // often learns its provider session id after the first send; clearing pending
  // on that transition briefly flashes the empty state before the transcript
  // user turn lands.
  useEffect(() => {
    setPending(readPendingSendCache(pendingScope))
    clearWorkingSuppression()
  }, [pendingScope])
  // Command markers are session-scoped because slash commands like /clear are
  // local feedback for a specific transcript boundary.
  useEffect(() => {
    setCommandMarkers(readCommandMarkerCache(commandMarkerScope))
    clearWorkingSuppression()
  }, [commandMarkerScope])
  // Prune echoes whose real user turn is now in the transcript.
  useEffect(() => {
    setPending((prev) => writePendingSendCache(pendingScope, prunePendingSends(prev, messages)))
  }, [messages, pendingScope])
  // Drop echoes the pane's current conversation can never match, so a replaced
  // conversation cannot strand an old prompt as its newest bubble. `commandMarkers`
  // is the trigger only: a chat-view move changes both scopes in one commit, so the
  // markers are re-read by scope rather than taken from state that still describes
  // the leaf we came from — judging by that writes a permanent drop.
  useEffect(() => {
    const markers = readCommandMarkerCache(commandMarkerScope)
    setPending((prev) => {
      const next = retainPendingSendsForConversation(prev, { sessionId, markers })
      return next === prev ? prev : writePendingSendCache(pendingScope, next)
    })
  }, [commandMarkers, commandMarkerScope, pendingScope, sessionId])
  const recordSend = useCallback(
    (text: string, imagePaths?: string[]) => {
      setWorkingInterrupted(false)
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
    [messages, pendingScope, sessionId, setWorkingInterrupted]
  )
  const cancelSend = useCallback(
    (pendingId: string) => {
      // Why: detach/interrupt cancels the delayed Enter, so its optimistic echo
      // must not come back from the pane cache as a prompt that was delivered,
      // and a later repeat must stop waiting on the slot it would have taken.
      const next = dropNativeChatPendingOccurrences(
        readPendingSendCache(pendingScope),
        (entry) => entry.id === pendingId
      )
      setPending(writePendingSendCache(pendingScope, next))
    },
    [pendingScope]
  )
  const recordSlashCommand = useCallback(
    (command: string) => {
      setCommandMarkers(appendCommandMarkerCache(commandMarkerScope, command))
    },
    [commandMarkerScope]
  )
  const clearPending = useCallback(() => {
    setPending(writePendingSendCache(pendingScope, []))
  }, [pendingScope])
  return { pending, commandMarkers, recordSend, cancelSend, recordSlashCommand, clearPending }
}
