import type { useStructuredAgentSession } from '../session/structured/use-structured-agent-session'
import type { ComponentProps, ReactNode } from 'react'
import type {
  selectNativeChatViewState,
  structuredChatHistoryPhase
} from '../session/status/native-chat-view-state'
import type { structuredAgentSessionReadFailureNotice } from '../messages/notices/structured-agent-session-read-failure-notice'
import { NativeChatEmptyState } from './NativeChatEmptyState'
import { NativeChatEmptyPane } from './NativeChatEmptyPane'
import { NativeChatLoadingCue } from './NativeChatLoadingCue'

export function NativeChatStructuredHistoryState({
  viewState,
  historyPhase,
  readFailure,
  children,
  ...empty
}: ComponentProps<typeof NativeChatEmptyPane> & {
  viewState: ReturnType<typeof selectNativeChatViewState>
  historyPhase: ReturnType<typeof structuredChatHistoryPhase>
  readFailure: ReturnType<typeof structuredAgentSessionReadFailureNotice> | null
  children: ReactNode
}): ReactNode {
  if (viewState.kind === 'loading' || (viewState.kind === 'error' && !readFailure)) {
    return historyPhase !== 'unread' && <NativeChatLoadingCue />
  }
  if (viewState.kind === 'error') {
    return (
      <NativeChatEmptyState
        kind="error"
        retrying={!readFailure?.final}
        {...(readFailure?.named ? { headline: readFailure.text } : {})}
      />
    )
  }
  return viewState.kind === 'empty' ? <NativeChatEmptyPane {...empty} /> : children
}

export function structuredChatTranscriptProps(
  controller: ReturnType<typeof useStructuredAgentSession>
) {
  return {
    journalItems: controller.journalItems,
    journalSubmissions: controller.submissions,
    journalLatestTurn: controller.latestTurn,
    journalHostWork: controller.hostWork,
    subagentRoster: controller.subagentRoster,
    railOutline: controller.railOutline,
    isWorking: controller.isWorking,
    expandSignal: false,
    workingStartedAt: controller.workingStartedAt,
    settledTurns: controller.settledTurns,
    turnActivity: controller.turnActivity,
    structuredAttachments: true
  }
}
