import { CHAT_READ_MARK_FIELDS } from '../../../../../shared/agent-session/view/chat-read-mark-move'
import { capPaneKeyTimestampRecord } from '../../../../../shared/agent-session/view/pane-key-timestamp-record'
import {
  adoptChatReadMarkAliases,
  capWebChatReadMarkRecord,
  indexLoadedChatReadMarks
} from '../agent-status/structured-sessions/chat-read-mark-aliases'
import { moveLoadedWebChatReadMarks } from '../agent-status/structured-sessions/chat-read-mark-web-move'
import {
  rebaseWebChatReadMarks,
  WEB_CHAT_READ_MARK_FIELDS,
  type WebChatReadMarks
} from '@/web/preload-api/preferences/web-chat-read-mark-storage'
import type { AppState } from '../../types'
import type { PersistedUIWriteBaseline } from './persisted-ui-write-baseline'

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
    baseline[field] = web
      ? capWebChatReadMarkRecord(field, baseline[field])
      : capPaneKeyTimestampRecord(baseline[field])
  }

  if (localMarks) {
    for (const field of WEB_CHAT_READ_MARK_FIELDS) {
      const current = pending[field]
      localMarks[field] = current
        ? capWebChatReadMarkRecord(field, localMarks[field], current)
        : baseline[field]
    }
  }
  return { baseline, localMarks }
}
