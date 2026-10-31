import { useMemo } from 'react'
import type { NativeChatLaunchPrompt } from '@/lib/native-chat-launch-prompt'
import type { AgentType } from '../../../../shared/native-chat-types'
import {
  deriveNativeChatStreamingText,
  nativeChatStreamingMessage
} from '../../../../shared/native-chat/native-chat-streaming'
import {
  applyCommandMarkerBoundaries,
  commandMarkersAsMessages,
  type NativeChatCommandMarker
} from './native-chat-command-marker'
import type { NativeChatLiveSession } from './native-chat-live-session-contract'
import { launchPromptAsMessage } from './native-chat-pending'
import { pendingSendsAsMessages } from '../../../../shared/native-chat-pending-sends'
import { useNativeChatLaunchPromptDeliveryNotice } from './use-native-chat-launch-prompt-delivery-notice'
import { useNativeChatLocalCommandAnswer } from './use-native-chat-local-command-answer'
import type { useNativeChatPendingDelivery } from './use-native-chat-pending-delivery'

export function useNativeChatTerminalTranscript({
  session,
  launchPrompt,
  agent,
  commandMarkers,
  delivery,
  previewText,
  working,
  previewIsToolOutput
}: {
  session: NativeChatLiveSession
  launchPrompt: NativeChatLaunchPrompt | null
  agent: AgentType
  commandMarkers: NativeChatCommandMarker[]
  delivery: ReturnType<typeof useNativeChatPendingDelivery>
} & Omit<Parameters<typeof deriveNativeChatStreamingText>[0], 'messages'>) {
  const launchPromptMessage = useMemo(
    () => launchPromptAsMessage(launchPrompt, session.messages),
    [launchPrompt, session.messages]
  )
  const sessionWithLaunchPrompt = useMemo<NativeChatLiveSession>(
    () =>
      launchPromptMessage
        ? { ...session, messages: [...session.messages, launchPromptMessage] }
        : session,
    [launchPromptMessage, session]
  )
  const sessionAfterCommandBoundaries = useMemo<NativeChatLiveSession>(() => {
    const messages = applyCommandMarkerBoundaries(sessionWithLaunchPrompt.messages, commandMarkers)
    return messages === sessionWithLaunchPrompt.messages
      ? sessionWithLaunchPrompt
      : { ...sessionWithLaunchPrompt, messages }
  }, [sessionWithLaunchPrompt, commandMarkers])
  const answerLocally = useNativeChatLocalCommandAnswer(agent, sessionAfterCommandBoundaries)
  const launchNotices = useNativeChatLaunchPromptDeliveryNotice(
    launchPrompt?.failed ? launchPromptMessage?.id : null,
    sessionAfterCommandBoundaries.messages
  )
  const deliveryNotices = useMemo(
    () =>
      delivery.notices.size === 0
        ? launchNotices
        : new Map([...(launchNotices ?? []), ...delivery.notices]),
    [launchNotices, delivery.notices]
  )
  const pendingMessages = useMemo(
    () => pendingSendsAsMessages(delivery.pending, sessionAfterCommandBoundaries.messages),
    [delivery.pending, sessionAfterCommandBoundaries.messages]
  )
  const streamingText = useMemo(
    () =>
      deriveNativeChatStreamingText({
        messages:
          pendingMessages.length > 0
            ? [...sessionAfterCommandBoundaries.messages, ...pendingMessages]
            : sessionAfterCommandBoundaries.messages,
        previewText,
        working,
        previewIsToolOutput
      }),
    [
      sessionAfterCommandBoundaries.messages,
      pendingMessages,
      previewText,
      working,
      previewIsToolOutput
    ]
  )
  const sessionWithPending = useMemo<NativeChatLiveSession>(() => {
    if (delivery.pending.length === 0 && commandMarkers.length === 0 && !streamingText) {
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
  }, [
    sessionAfterCommandBoundaries,
    delivery.pending,
    pendingMessages,
    commandMarkers,
    streamingText
  ])
  return { answerLocally, deliveryNotices, sessionAfterCommandBoundaries, sessionWithPending }
}
