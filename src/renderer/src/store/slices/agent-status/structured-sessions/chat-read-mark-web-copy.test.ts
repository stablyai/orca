import { expect, it } from 'vitest'
import type { AppState } from '../../../types'
import { copyWebClientChatReadMarksOnce } from './chat-read-mark-web-copy'

const LEAF = '2b8ea975-8113-41ae-a25c-feb50cbe084a'
const TAB_KEY = `agent-chat-tab-v1-abc:${LEAF}`
const CONVERSATION_KEY = `structured-agent-session-sess-2:${LEAF}`

it('copies a web client’s own cutoffs and unread turns once, leaving acknowledgements to the host', () => {
  let state: Pick<
    AppState,
    | 'unifiedTabsByWorktree'
    | 'acknowledgedAgentsByPaneKey'
    | 'activityClearedAtByPaneKey'
    | 'manuallyUnreadTurnsByPaneKey'
    | 'chatReadMarksCopiedHere'
  > = {
    unifiedTabsByWorktree: {
      wt: [
        {
          id: 'agent-chat-tab-v1-abc',
          entityId: 'sess-2',
          groupId: 'g',
          worktreeId: 'wt',
          contentType: 'agent-session',
          label: 'Chat',
          customLabel: null,
          color: null,
          sortOrder: 0,
          createdAt: 0
        }
      ]
    },
    acknowledgedAgentsByPaneKey: { [TAB_KEY]: 100 },
    activityClearedAtByPaneKey: { [TAB_KEY]: 50 },
    manuallyUnreadTurnsByPaneKey: { [TAB_KEY]: 70 },
    chatReadMarksCopiedHere: false
  }
  const store = {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the copy reads only these fields.
    getState: () => state as AppState,
    setState: (patch: Partial<AppState>) => {
      state = { ...state, ...patch }
    }
  }
  copyWebClientChatReadMarksOnce(store)
  expect(state.activityClearedAtByPaneKey).toEqual({ [TAB_KEY]: 50, [CONVERSATION_KEY]: 50 })
  expect(state.manuallyUnreadTurnsByPaneKey).toEqual({ [TAB_KEY]: 70, [CONVERSATION_KEY]: 70 })
  expect(state.acknowledgedAgentsByPaneKey).toEqual({ [TAB_KEY]: 100 })
  expect(state.chatReadMarksCopiedHere).toBe(true)
  // Clearing the copied cutoff later must not bring it back.
  state = { ...state, activityClearedAtByPaneKey: { [TAB_KEY]: 50 } }
  copyWebClientChatReadMarksOnce(store)
  expect(state.activityClearedAtByPaneKey).toEqual({ [TAB_KEY]: 50 })
})
