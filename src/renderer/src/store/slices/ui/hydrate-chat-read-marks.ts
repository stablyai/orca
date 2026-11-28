import { CHAT_READ_MARK_FIELDS } from '../../../../../shared/agent-session/view/chat-read-mark-move'
import { capPaneKeyTimestampRecord } from '../../../../../shared/agent-session/view/pane-key-timestamp-record'
import { chatPaneKey } from '../../../../../shared/agent-session/view/structured-agent-session-projection'
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

function livePaneKeysToRetain(state: AppState): Record<string, number> | undefined {
  let retained: Record<string, number> | undefined
  if (state.agentStatusByPaneKey) {
    for (const paneKey of state.agentStatusByPaneKey.keys()) {
      retained ??= {}
      retained[paneKey] = 1
    }
  }
  if (state.unifiedTabsByWorktree) {
    for (const tabs of Object.values(state.unifiedTabsByWorktree)) {
      for (const tab of tabs) {
        if (tab.contentType === 'agent-session') {
          retained ??= {}
          retained[chatPaneKey(tab.entityId)] = 1
        }
      }
    }
  }
  return retained
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

  const liveRetain = livePaneKeysToRetain(state)
  baseline = { ...baseline }
  for (const field of CHAT_READ_MARK_FIELDS) {
    const retain = field === 'activityClearedAtByPaneKey' ? liveRetain : undefined
    baseline[field] = web
      ? capWebChatReadMarkRecord(field, baseline[field], retain)
      : capPaneKeyTimestampRecord(baseline[field], retain)
  }

  if (localMarks) {
    for (const field of WEB_CHAT_READ_MARK_FIELDS) {
      const current = pending[field]
      const retain =
        field === 'activityClearedAtByPaneKey' && liveRetain
          ? { ...liveRetain, ...current }
          : current
      localMarks[field] = retain
        ? capWebChatReadMarkRecord(field, localMarks[field], retain)
        : baseline[field]
    }
  }
  return { baseline, localMarks }
}
