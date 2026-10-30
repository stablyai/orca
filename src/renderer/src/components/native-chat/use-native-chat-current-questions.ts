import type { UseNativeChatLiveSessionArgs } from './native-chat-live-session-contract'
import { useCallback, useMemo, useState } from 'react'
import { createNativeChatCurrentRequestsBinding } from '../../../../shared/native-chat-current-requests-binding'
import {
  authoritativeAsyncQuestion,
  currentMessageQuestionView,
  type AgentSessionCurrentRequestsState
} from '../../../../shared/agent-session-current-requests'

export function useNativeChatCurrentQuestions(args: UseNativeChatLiveSessionArgs) {
  const source = JSON.stringify([
    args.paneKey,
    args.runtimeEnvironmentId,
    args.agent,
    args.sessionId,
    args.transcriptPath
  ])
  const [requests, setRequests] = useState<AgentSessionCurrentRequestsState & { source?: string }>(
    {}
  )
  const bind = useCallback(
    (read: Parameters<typeof createNativeChatCurrentRequestsBinding>[0]['read']) =>
      createNativeChatCurrentRequestsBinding({
        read,
        publish: (state) => setRequests({ ...state, source })
      }),
    [source]
  )
  const view = useMemo(
    () => ({
      asyncQuestion: requests.source === source ? authoritativeAsyncQuestion(requests) : undefined,
      messageQuestions:
        requests.source === source ? currentMessageQuestionView(requests) : undefined
    }),
    [requests, source]
  )
  return [source, view, bind] as const
}
