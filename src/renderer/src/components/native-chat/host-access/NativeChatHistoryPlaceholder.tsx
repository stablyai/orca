import type { ComponentProps } from 'react'
import type { structuredAgentSessionReadFailureNotice } from '@/components/native-chat/messages/notices/structured-agent-session-read-failure-notice'
import { NativeChatWorkerChipColumn } from '../tools/tasks/dock/NativeChatWorkerChipColumn'
import { NativeChatEmptyPane } from './NativeChatEmptyPane'
import { NativeChatEmptyState } from './NativeChatEmptyState'
import { NativeChatLoadingCue } from './NativeChatLoadingCue'

/** What the transcript shows before there is a conversation to list (history loading, unreadable,
 *  or empty), with the worker chip's slot at its end as the message list would have it. */
export function NativeChatHistoryPlaceholder({
  kind,
  readFailure,
  cue,
  pane
}: {
  kind: 'loading' | 'error' | 'empty'
  readFailure: ReturnType<typeof structuredAgentSessionReadFailureNotice> | null
  /** Whether the loading cue shows (not while history is still unread). */
  cue: boolean
  pane: ComponentProps<typeof NativeChatEmptyPane>
}) {
  return (
    <NativeChatWorkerChipColumn>
      {kind === 'loading' || (kind === 'error' && !readFailure) ? (
        cue && <NativeChatLoadingCue />
      ) : kind === 'error' ? (
        <NativeChatEmptyState
          kind="error"
          retrying={!readFailure?.final}
          {...(readFailure?.named ? { headline: readFailure.text } : {})}
        />
      ) : (
        <NativeChatEmptyPane {...pane} />
      )}
    </NativeChatWorkerChipColumn>
  )
}
