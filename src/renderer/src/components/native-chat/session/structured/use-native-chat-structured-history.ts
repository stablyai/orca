import type { NativeChatStructuredViewProps } from '@/components/native-chat/native-chat-view-types'
import type { AgentSessionRefusalReference } from '../../../../../../shared/agent-session/failures/agent-session-wire-refusals'
import {
  useStructuredChatLiveSession,
  type StructuredChatController
} from './use-structured-chat-live-session'
import { useNativeChatHostOutage } from '@/components/native-chat/host-access/use-native-chat-host-outage'
import { useNativeChatHostOutageNotice } from '@/components/native-chat/host-access/use-native-chat-host-outage-notice'
import { useNativeChatHostSendGate } from '@/components/native-chat/host-access/use-native-chat-host-send-gate'
import { structuredAgentSessionReadFailureNotice } from '@/components/native-chat/messages/notices/structured-agent-session-read-failure-notice'
import {
  selectNativeChatViewState,
  structuredChatHistoryPhase,
  type StructuredChatHistoryLaunch
} from '../status/native-chat-view-state'

export function useNativeChatStructuredHistory(
  {
    target,
    sessionId,
    agent
  }: Pick<NativeChatStructuredViewProps, 'target' | 'sessionId' | 'agent'>,
  controller: StructuredChatController & { readRefusal?: AgentSessionRefusalReference },
  provisionalLaunch: StructuredChatHistoryLaunch
) {
  const historyPhase = structuredChatHistoryPhase(provisionalLaunch, controller.status)
  const hostOutage = useNativeChatHostOutage(target)
  const hostNotice = useNativeChatHostOutageNotice(hostOutage)
  const session = useStructuredChatLiveSession(
    controller,
    historyPhase,
    sessionId,
    agent,
    hostOutage === null
  )
  const hostSendGate = useNativeChatHostSendGate(target, agent, hostOutage)
  // A lost contact is the host notice's to say; the read adds only a refusal the host sent.
  const readFailure =
    controller.status === 'error' && !(hostOutage && !controller.readRefusal)
      ? structuredAgentSessionReadFailureNotice(controller.readRefusal)
      : null
  const viewState = selectNativeChatViewState(session, { readRetries: readFailure?.final !== true })
  return { historyPhase, hostNotice, session, hostSendGate, readFailure, viewState }
}
