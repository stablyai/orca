import { useMemo } from 'react'
import { pendingSendsAsMessages } from '../../../../../../../shared/native-chat/transcript/native-chat-pending-sends'
import type { NativeChatLaunchPrompt } from '../../../drafts/native-chat-launch-prompt'
import type { useNativeChatRetainedSession } from '../read/use-native-chat-retained-session'
import { launchPromptAsMessage } from './native-chat-pending'
import {
  applyCommandMarkerBoundaries,
  type NativeChatCommandMarker
} from './native-chat-command-marker'

export function useNativeChatDeliveryProjection(
  paneLaunchPrompt: NativeChatLaunchPrompt | null,
  session: ReturnType<typeof useNativeChatRetainedSession>,
  commandMarkers: NativeChatCommandMarker[]
) {
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
  pending: Parameters<typeof pendingSendsAsMessages>[0],
  messages: NonNullable<Parameters<typeof pendingSendsAsMessages>[1]>,
  sendWorkingEpoch: Parameters<typeof pendingSendsAsMessages>[2],
  sessionId: ReturnType<typeof useNativeChatRetainedSession>['sessionId']
) {
  const pendingMessages = useMemo(
    () => pendingSendsAsMessages(pending, messages, sendWorkingEpoch, sessionId ?? ''),
    [pending, messages, sendWorkingEpoch, sessionId]
  )
  const messagesWithPending = useMemo(
    () => (pendingMessages.length === 0 ? messages : [...messages, ...pendingMessages]),
    [messages, pendingMessages]
  )
  return { pendingMessages, messagesWithPending }
}
