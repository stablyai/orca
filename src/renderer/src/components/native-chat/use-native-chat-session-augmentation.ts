import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type SetStateAction
} from 'react'
import type { NativeChatLaunchPrompt } from '@/lib/native-chat-launch-prompt'
import type { NativeChatSession } from '../../../../shared/native-chat-types'
import type { NativeChatLiveSession } from './use-native-chat-live-session'
import { selectNativeChatViewState, type NativeChatViewState } from './native-chat-view-state'
import {
  appendPendingSendCache,
  launchPromptAsMessage,
  pendingSendsAsMessages,
  nextNativeChatPendingSendId,
  prunePendingSends,
  readPendingSendCache,
  shouldPruneLaunchPrompt,
  writePendingSendCache,
  type NativeChatPendingSend
} from './native-chat-pending'
import {
  appendCommandMarkerCache,
  applyCommandMarkerBoundaries,
  commandMarkersAsMessages,
  readCommandMarkerCache,
  type NativeChatCommandMarker
} from './native-chat-command-marker'
import {
  deriveNativeChatStreamingText,
  nativeChatStreamingMessage
} from '../../../../shared/native-chat-streaming'

/**
 * Layers the chat view's local-only content on top of the transcript session: the optimistic
 * "queued" echo of a just-sent message (mobile parity — pruned once the real transcript turn
 * lands), the "Ran /clear" system line for a dispatched slash command, the launch-context
 * draft-as-message, and the in-flight streaming preview bubble. None of these are transcript
 * turns, so they never touch the source session — they're composed fresh on every render into
 * `sessionWithPending`, the one session NativeChatMessageList actually renders.
 *
 * Pulled out of NativeChatResolvedView (native-chat-view.tsx) as its own cohesive unit —
 * everything here answers "what does the pending-augmented conversation look like," nothing
 * here decides send eligibility, startup dialogs, or composer focus.
 */
export function useNativeChatSessionAugmentation(args: {
  paneKey: string
  agent: NativeChatSession['agent']
  sessionId: string | null
  session: NativeChatLiveSession
  terminalTabId: string
  paneLaunchPrompt: NativeChatLaunchPrompt | null
  clearNativeChatLaunchPrompt: (terminalTabId: string) => void
  hookPreview: string | undefined
  liveWorking: boolean
  setWorkingInterrupted: Dispatch<SetStateAction<boolean>>
}): {
  sessionWithPending: NativeChatLiveSession
  sessionAfterCommandBoundariesMessages: NativeChatSession['messages']
  viewState: NativeChatViewState
  failedLaunchPromptMessageIds: Set<string> | undefined
  onOptimisticSend: (text: string, imagePaths?: string[]) => string | undefined
  onOptimisticSendCanceled: (pendingId: string) => void
  onSlashCommand: (command: string) => void
  clearPendingSends: () => void
} {
  const {
    paneKey,
    agent,
    sessionId,
    session,
    terminalTabId,
    paneLaunchPrompt,
    clearNativeChatLaunchPrompt,
    hookPreview,
    liveWorking,
    setWorkingInterrupted
  } = args

  // Optimistic "queued" sends (mobile parity): a composer send is echoed
  // immediately and pruned once its real user turn lands in the transcript, so
  // the message never vanishes between send and transcript catch-up.
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
    setWorkingInterrupted(false)
  }, [pendingScope, setWorkingInterrupted])
  // Command markers are session-scoped because slash commands like /clear are
  // local feedback for a specific transcript boundary.
  useEffect(() => {
    setCommandMarkers(readCommandMarkerCache(commandMarkerScope))
    setWorkingInterrupted(false)
  }, [commandMarkerScope, setWorkingInterrupted])
  // Prune echoes whose real user turn is now in the transcript.
  useEffect(() => {
    setPending((prev) =>
      writePendingSendCache(pendingScope, prunePendingSends(prev, session.messages))
    )
  }, [session.messages, pendingScope])
  useEffect(() => {
    if (!paneLaunchPrompt || !shouldPruneLaunchPrompt(paneLaunchPrompt, session.messages)) {
      return
    }
    clearNativeChatLaunchPrompt(terminalTabId)
  }, [clearNativeChatLaunchPrompt, paneLaunchPrompt, session.messages, terminalTabId])
  const onOptimisticSend = useCallback(
    (text: string, imagePaths?: string[]) => {
      setWorkingInterrupted(false)
      const sentAt = Date.now()
      const boundary = session.messages.at(-1)
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
    [pendingScope, session.messages, setWorkingInterrupted]
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
  // Why here and not in stopAgent's own file: clearing pending must go through the same
  // scoped cache write as every other pending mutation above.
  const clearPendingSends = useCallback(() => {
    setPending(writePendingSendCache(pendingScope, []))
  }, [pendingScope])

  const launchPromptMessage = useMemo(
    () => launchPromptAsMessage(paneLaunchPrompt, session.messages),
    [paneLaunchPrompt, session.messages]
  )
  const sessionWithLaunchPrompt = useMemo<NativeChatLiveSession>(() => {
    if (!launchPromptMessage) {
      return session
    }
    return { ...session, messages: [...session.messages, launchPromptMessage] }
  }, [launchPromptMessage, session])

  const sessionAfterCommandBoundaries = useMemo<NativeChatLiveSession>(() => {
    const messages = applyCommandMarkerBoundaries(sessionWithLaunchPrompt.messages, commandMarkers)
    return messages === sessionWithLaunchPrompt.messages
      ? sessionWithLaunchPrompt
      : { ...sessionWithLaunchPrompt, messages }
  }, [sessionWithLaunchPrompt, commandMarkers])
  const failedLaunchPromptMessageIds = useMemo(() => {
    const id = paneLaunchPrompt?.failed ? launchPromptMessage?.id : null
    if (!id || !sessionAfterCommandBoundaries.messages.some((message) => message.id === id)) {
      return undefined
    }
    return new Set([id])
  }, [paneLaunchPrompt?.failed, launchPromptMessage?.id, sessionAfterCommandBoundaries.messages])

  // The streaming preview bubble (if any) sits after the transcript but before
  // the optimistic user echoes — same order mobile uses.
  const pendingMessages = useMemo(
    () => pendingSendsAsMessages(pending, sessionAfterCommandBoundaries.messages),
    [pending, sessionAfterCommandBoundaries.messages]
  )
  const streamingText = useMemo(() => {
    return deriveNativeChatStreamingText({
      messages:
        pendingMessages.length > 0
          ? [...sessionAfterCommandBoundaries.messages, ...pendingMessages]
          : sessionAfterCommandBoundaries.messages,
      previewText: hookPreview,
      working: liveWorking
    })
  }, [sessionAfterCommandBoundaries.messages, pendingMessages, hookPreview, liveWorking])
  const sessionWithPending = useMemo<NativeChatLiveSession>(() => {
    if (pending.length === 0 && commandMarkers.length === 0 && !streamingText) {
      return sessionAfterCommandBoundaries
    }
    return {
      ...sessionAfterCommandBoundaries,
      messages: [
        ...sessionAfterCommandBoundaries.messages,
        ...commandMarkersAsMessages(commandMarkers),
        ...(streamingText ? [nativeChatStreamingMessage(streamingText)] : []),
        ...pendingMessages
      ]
    }
  }, [sessionAfterCommandBoundaries, pending, pendingMessages, commandMarkers, streamingText])
  // Derive the view state from the pending-augmented session so a send into an
  // otherwise-empty conversation flips to the list (showing the queued bubble)
  // instead of staying on the empty state.
  const viewState = selectNativeChatViewState(sessionWithPending)

  return {
    sessionWithPending,
    sessionAfterCommandBoundariesMessages: sessionAfterCommandBoundaries.messages,
    viewState,
    failedLaunchPromptMessageIds,
    onOptimisticSend,
    onOptimisticSendCanceled,
    onSlashCommand,
    clearPendingSends
  }
}
