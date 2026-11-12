import { pendingSendsAsMessages } from '../../../../../../../shared/native-chat/transcript/native-chat-pending-sends'
import {
  deriveNativeChatStreamingText,
  nativeChatStreamingMessage
} from '../../../../../../../shared/native-chat/native-chat-streaming'
import { useEffect, useMemo } from 'react'
import { useAppStore } from '@/store'
import type { NativeChatLaunchPrompt } from '../../../drafts/native-chat-launch-prompt'
import type { useNativeChatRetainedSession } from '../read/use-native-chat-retained-session'
import { launchPromptAsMessage, shouldPruneLaunchPrompt } from './native-chat-pending'
import {
  applyCommandMarkerBoundaries,
  commandMarkersAsMessages,
  type NativeChatCommandMarker
} from './native-chat-command-marker'

export function useNativeChatDeliveryProjection(
  paneLaunchPrompt: NativeChatLaunchPrompt | null,
  session: ReturnType<typeof useNativeChatRetainedSession>,
  commandMarkers: NativeChatCommandMarker[],
  terminalTabId: string
) {
  const clearNativeChatLaunchPrompt = useAppStore((s) => s.clearNativeChatLaunchPrompt)
  useEffect(() => {
    if (!paneLaunchPrompt || !shouldPruneLaunchPrompt(paneLaunchPrompt, session.messages)) {
      return
    }
    clearNativeChatLaunchPrompt(terminalTabId)
  }, [clearNativeChatLaunchPrompt, paneLaunchPrompt, session.messages, terminalTabId])

  const launchPromptMessage = useMemo(
    () => launchPromptAsMessage(paneLaunchPrompt, session.messages),
    [paneLaunchPrompt, session.messages]
  )
  const sessionWithLaunchPrompt = useMemo<typeof session>(() => {
    if (!launchPromptMessage) {
      return session
    }
    return { ...session, messages: [...session.messages, launchPromptMessage] }
  }, [launchPromptMessage, session])

  const sessionAfterCommandBoundaries = useMemo<typeof session>(() => {
    const messages = applyCommandMarkerBoundaries(sessionWithLaunchPrompt.messages, commandMarkers)
    return messages === sessionWithLaunchPrompt.messages
      ? sessionWithLaunchPrompt
      : { ...sessionWithLaunchPrompt, messages }
  }, [sessionWithLaunchPrompt, commandMarkers])
  return { launchPromptMessage, sessionAfterCommandBoundaries }
}

export function useNativeChatPendingProjection(
  sessionAfterCommandBoundaries: ReturnType<typeof useNativeChatRetainedSession>,
  pending: Parameters<typeof pendingSendsAsMessages>[0],
  commandMarkers: NativeChatCommandMarker[],
  sendWorkingEpoch: Parameters<typeof pendingSendsAsMessages>[2],
  hookPreview: Parameters<typeof deriveNativeChatStreamingText>[0]['previewText'],
  liveWorking: boolean,
  hookPreviewIsToolOutput: boolean
) {
  const pendingMessages = useMemo(
    () => pendingSendsAsMessages(pending, sessionAfterCommandBoundaries.messages, sendWorkingEpoch),
    [pending, sessionAfterCommandBoundaries.messages, sendWorkingEpoch]
  )
  const messagesWithPending = useMemo(
    () =>
      pendingMessages.length === 0
        ? sessionAfterCommandBoundaries.messages
        : [...sessionAfterCommandBoundaries.messages, ...pendingMessages],
    [sessionAfterCommandBoundaries.messages, pendingMessages]
  )
  const streamingText = useMemo(() => {
    return deriveNativeChatStreamingText({
      messages: messagesWithPending,
      previewText: hookPreview,
      working: liveWorking,
      previewIsToolOutput: hookPreviewIsToolOutput
    })
  }, [messagesWithPending, hookPreview, liveWorking, hookPreviewIsToolOutput])
  const sessionWithPending = useMemo<typeof sessionAfterCommandBoundaries>(() => {
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
  return sessionWithPending
}
