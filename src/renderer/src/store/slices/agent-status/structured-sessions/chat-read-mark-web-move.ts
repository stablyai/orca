import type { RuntimeMobileSessionSnapshotTab } from '../../../../../../shared/remote-runtime/session-graph/runtime-mobile-session-tab-contracts'
import type { ChatReadMarkMatches } from '../../../../../../shared/agent-session/view/chat-read-mark-move'
import { readManualUnreadProtectionTurn } from '@/attention/agent-attention-acknowledgement'
import {
  type WebChatReadMarks,
  writeWebChatReadMarkEdits
} from '@/web/preload-api/preferences/web-chat-read-mark-storage'
import {
  diffPersistedUIWriteFields,
  type PersistedUIWriteBaseline
} from '../../ui/persisted-ui-write-baseline'
import type { AppState } from '../../../types'
import {
  canMoveWebChatReadMarks,
  loadedChatReadMarkMatches,
  matchWebChatReadMarkReceipt
} from './chat-read-mark-aliases'

type MarkState = PersistedUIWriteBaseline & Pick<AppState, 'agentStatusByPaneKey'>

function moveMatches(
  state: MarkState,
  baseline: PersistedUIWriteBaseline,
  candidates: ChatReadMarkMatches,
  retain?: WebChatReadMarks
) {
  const known = loadedChatReadMarkMatches()
  const moveKeys = new Set<string>()
  for (const [leaf, key] of candidates) {
    const previous = known.get(leaf)
    const match = previous === undefined || previous === key ? key : null
    known.set(leaf, match)
    if (match) {
      moveKeys.add(match)
    }
  }
  if (moveKeys.size === 0) {
    return undefined
  }

  const changes = diffPersistedUIWriteFields(state, baseline)
  try {
    const marks = writeWebChatReadMarkEdits(changes, baseline, {
      moveKeys,
      retain,
      currentTurn: (key) =>
        readManualUnreadProtectionTurn({ liveTurns: state.agentStatusByPaneKey }, key) ?? undefined
    })
    return { ...marks, persistedUIWriteBaseline: { ...baseline, ...marks } }
  } catch {
    return undefined
  }
}

export function moveLoadedWebChatReadMarks(state: MarkState, baseline: PersistedUIWriteBaseline) {
  if (canMoveWebChatReadMarks()) {
    return moveMatches(state, baseline, loadedChatReadMarkMatches())
  }
  return undefined
}

export function createWebChatReadMarkReceiptBatch() {
  if (!canMoveWebChatReadMarks()) {
    return undefined
  }
  const candidates: ChatReadMarkMatches = new Map()
  const visit = (sessionId: string) => matchWebChatReadMarkReceipt(candidates, sessionId)
  return {
    collect(
      tabs: readonly RuntimeMobileSessionSnapshotTab[],
      scanChatSessions?: (visitSession?: (sessionId: string) => void) => void
    ): void {
      const eligible = canMoveWebChatReadMarks()
      if (scanChatSessions) {
        scanChatSessions(eligible ? visit : undefined)
      } else if (eligible) {
        for (const tab of tabs) {
          if (tab.type === 'agent-session') {
            visit(tab.sessionId)
          }
        }
      }
    },
    move(state: MarkState & Pick<AppState, 'persistedUIWriteBaseline'>) {
      if (candidates.size > 0 && state.persistedUIWriteBaseline && canMoveWebChatReadMarks()) {
        return moveMatches(state, state.persistedUIWriteBaseline, candidates, state)
      }
      return undefined
    }
  }
}
