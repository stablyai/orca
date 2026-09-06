// The message-list assembly pipeline extracted from NativeChatView.tsx to
// stay under the file's line ratchet: launch-prompt splice -> command-marker
// boundaries -> streaming/RPC-overlay splice. Pure relocation, no behavior
// change to the moved code; only the RPC-overlay spread (W2-2) is new.

import { useMemo } from 'react'
import type { NativeChatLaunchPrompt } from '@/lib/native-chat-launch-prompt'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import {
  deriveNativeChatStreamingText,
  nativeChatStreamingMessage
} from '../../../../shared/native-chat-streaming'
import type { NativeChatLiveSession } from './use-native-chat-live-session'
import {
  applyCommandMarkerBoundaries,
  commandMarkersAsMessages,
  type NativeChatCommandMarker
} from './native-chat-command-marker'
import {
  launchPromptAsMessage,
  pendingSendsAsMessages,
  type NativeChatPendingSend
} from './native-chat-pending'

export type UseNativeChatMessageListSessionArgs = {
  session: NativeChatLiveSession
  paneLaunchPrompt: NativeChatLaunchPrompt | null
  commandMarkers: NativeChatCommandMarker[]
  pending: NativeChatPendingSend[]
  liveWorking: boolean
  /** Hook-preview text, already suppressed for an RPC-owned pane (D5's "one
   *  live overlay only" — see use-native-chat-omp-rpc-integration.ts). */
  hookPreview: string | null | undefined
  /** Several providers publish a tool's stdout/error on the same hook field for
   *  status-card previews. That text is not the reply and never lands in a
   *  transcript assistant block, so the catch-up rules can never retire it —
   *  it hard-gates the streaming bubble instead. */
  hookPreviewIsToolOutput: boolean
  /** The RPC turn overlay (D4); empty whenever the pane isn't RPC-owned. */
  overlayMessages: readonly NativeChatMessage[]
}

export type NativeChatMessageListSession = {
  sessionAfterCommandBoundaries: NativeChatLiveSession
  sessionWithPending: NativeChatLiveSession
  failedLaunchPromptMessageIds: Set<string> | undefined
}

export function useNativeChatMessageListSession(
  args: UseNativeChatMessageListSessionArgs
): NativeChatMessageListSession {
  const {
    session,
    paneLaunchPrompt,
    commandMarkers,
    pending,
    liveWorking,
    hookPreview,
    hookPreviewIsToolOutput,
    overlayMessages
  } = args

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
      working: liveWorking,
      previewIsToolOutput: hookPreviewIsToolOutput
    })
  }, [
    sessionAfterCommandBoundaries.messages,
    pendingMessages,
    hookPreview,
    liveWorking,
    hookPreviewIsToolOutput
  ])
  const sessionWithPending = useMemo<NativeChatLiveSession>(() => {
    if (
      pending.length === 0 &&
      commandMarkers.length === 0 &&
      !streamingText &&
      overlayMessages.length === 0
    ) {
      return sessionAfterCommandBoundaries
    }
    return {
      ...sessionAfterCommandBoundaries,
      messages: [
        ...sessionAfterCommandBoundaries.messages,
        ...commandMarkersAsMessages(commandMarkers),
        // Streaming text (hook preview) and the RPC overlay are mutually
        // exclusive (D5/D4's "never both") — the caller suppresses whichever
        // one an RPC-owned pane must not show, so both spreads are safe here.
        ...(streamingText ? [nativeChatStreamingMessage(streamingText)] : []),
        ...overlayMessages,
        ...pendingMessages
      ]
    }
  }, [
    sessionAfterCommandBoundaries,
    pending,
    pendingMessages,
    commandMarkers,
    streamingText,
    overlayMessages
  ])

  return { sessionAfterCommandBoundaries, sessionWithPending, failedLaunchPromptMessageIds }
}
