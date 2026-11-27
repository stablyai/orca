import {
  CHAT_READ_MARK_FIELDS,
  type ChatReadMarkField
} from '../../../../../shared/agent-session/view/chat-read-mark-move'
import { capPaneKeyTimestampRecord } from '../../../../../shared/agent-session/view/pane-key-timestamp-record'
import {
  adoptChatReadMarkAliases,
  hasLoadedChatReadMarkAliases,
  indexLoadedChatReadMarks
} from '../agent-status/structured-sessions/chat-read-mark-aliases'
import { moveLoadedWebChatReadMarks } from '../agent-status/structured-sessions/chat-read-mark-web-move'
import {
  rebaseWebChatReadMarks,
  type WebChatReadMarks
} from '@/web/preload-api/preferences/web-chat-read-mark-storage'
import type { AppState } from '../../types'
import type { PersistedUIWriteBaseline } from './persisted-ui-write-baseline'

function capHydratedMark(field: ChatReadMarkField, record: Record<string, number>) {
  return hasLoadedChatReadMarkAliases(field) ? record : capPaneKeyTimestampRecord(record)
}

export function hydrateChatReadMarks(
  state: AppState,
  incoming: PersistedUIWriteBaseline,
  pending: Partial<PersistedUIWriteBaseline>,
  web: boolean
): { baseline: PersistedUIWriteBaseline; localMarks?: WebChatReadMarks } {
  const previous = state.persistedUIWriteBaseline
  let baseline = incoming
  let localMarks: WebChatReadMarks | undefined
  if (!previous) {
    indexLoadedChatReadMarks(incoming, web)
    if (web) {
      const moved = moveLoadedWebChatReadMarks(
        { ...incoming, agentStatusByPaneKey: state.agentStatusByPaneKey },
        incoming
      )
      baseline = moved?.persistedUIWriteBaseline ?? incoming
    }
  } else {
    if (web) {
      localMarks = rebaseWebChatReadMarks(incoming, pending, previous).marks
    }
    adoptChatReadMarkAliases(incoming)
  }

  baseline = { ...baseline }
  for (const field of CHAT_READ_MARK_FIELDS) {
    baseline[field] = capHydratedMark(field, baseline[field])
  }

  if (localMarks) {
    localMarks.activityClearedAtByPaneKey = capHydratedMark(
      'activityClearedAtByPaneKey',
      localMarks.activityClearedAtByPaneKey
    )
    localMarks.manuallyUnreadTurnsByPaneKey = capHydratedMark(
      'manuallyUnreadTurnsByPaneKey',
      localMarks.manuallyUnreadTurnsByPaneKey
    )
  }
  return { baseline, localMarks }
}
