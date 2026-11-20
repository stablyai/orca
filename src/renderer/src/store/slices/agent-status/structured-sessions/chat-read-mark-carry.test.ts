import { expect, it } from 'vitest'
import type { AppState } from '../../../types'
import {
  carriedChatReadMarks,
  carryChatAcknowledgementsAfterSync,
  carryChatReadMarks,
  chatReadMarkRecordsCarriedHere
} from './chat-read-mark-carry'

const LEAF = '2b8ea975-8113-41ae-a25c-feb50cbe084a'
const CONVERSATION_KEY = `structured-agent-session-sess-2:${LEAF}`

type CarryState = Pick<
  AppState,
  | 'unifiedTabsByWorktree'
  | 'acknowledgedAgentsByPaneKey'
  | 'activityClearedAtByPaneKey'
  | 'manuallyUnreadTurnsByPaneKey'
  | 'chatReadMarksCarriedFrom'
>

function chatTabState(tabId: string, marks: Partial<CarryState>): CarryState {
  return {
    unifiedTabsByWorktree: {
      wt: [
        {
          id: tabId,
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
    acknowledgedAgentsByPaneKey: {},
    activityClearedAtByPaneKey: {},
    manuallyUnreadTurnsByPaneKey: {},
    chatReadMarksCarriedFrom: {},
    ...marks
  }
}

function storeOver(state: { current: CarryState }): Parameters<typeof carryChatReadMarks>[0] {
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the carry reads only these fields.
    getState: () => state.current as AppState,
    setState: (patch) => {
      state.current = { ...state.current, ...patch }
    }
  }
}

it('copies a replaced chat’s saved read marks to its conversation key and keeps the originals', () => {
  const tabKey = `structured-agent-session-old:${LEAF}`
  const patch = carriedChatReadMarks(
    chatTabState('structured-agent-session-old', {
      acknowledgedAgentsByPaneKey: { [tabKey]: 100 },
      activityClearedAtByPaneKey: { [tabKey]: 200 }
    }),
    [{ id: 'structured-agent-session-old', contentType: 'agent-session', entityId: 'sess-2' }]
  )
  expect(patch).toEqual({
    acknowledgedAgentsByPaneKey: { [tabKey]: 100, [CONVERSATION_KEY]: 100 },
    activityClearedAtByPaneKey: { [tabKey]: 200, [CONVERSATION_KEY]: 200 },
    chatReadMarksCarriedFrom: {
      [`acknowledgedAgentsByPaneKey ${tabKey}`]: 100,
      [`activityClearedAtByPaneKey ${tabKey}`]: 200
    }
  })
})

it('does not carry a mark back after the chat is marked unread', () => {
  const tabKey = `agent-chat-tab-v1-abc:${LEAF}`
  const state = {
    current: chatTabState('agent-chat-tab-v1-abc', {
      acknowledgedAgentsByPaneKey: { [tabKey]: 300 }
    })
  }
  carryChatReadMarks(storeOver(state), chatReadMarkRecordsCarriedHere(false))
  expect(state.current.acknowledgedAgentsByPaneKey).toEqual({
    [tabKey]: 300,
    [CONVERSATION_KEY]: 300
  })
  // Mark unread deletes the conversation key; the next start must not restore it.
  state.current = { ...state.current, acknowledgedAgentsByPaneKey: { [tabKey]: 300 } }
  carryChatReadMarks(storeOver(state), chatReadMarkRecordsCarriedHere(false))
  expect(state.current.acknowledgedAgentsByPaneKey).toEqual({ [tabKey]: 300 })
})

it('carries an acknowledgement an older paired client later changes under a replaced chat’s tab key', () => {
  const tabKey = `structured-agent-session-old:${LEAF}`
  const state = {
    current: chatTabState('structured-agent-session-old', {
      acknowledgedAgentsByPaneKey: { [tabKey]: 400, [CONVERSATION_KEY]: 300 },
      chatReadMarksCarriedFrom: { [`acknowledgedAgentsByPaneKey ${tabKey}`]: 300 }
    })
  }
  carryChatAcknowledgementsAfterSync(storeOver(state), { [tabKey]: 300, [CONVERSATION_KEY]: 300 })
  expect(state.current.acknowledgedAgentsByPaneKey).toEqual({
    [tabKey]: 400,
    [CONVERSATION_KEY]: 400
  })
})

it('leaves a paired web client’s shared acknowledgements to its host to carry', () => {
  const tabKey = `agent-chat-tab-v1-abc:${LEAF}`
  const state = {
    current: chatTabState('agent-chat-tab-v1-abc', {
      acknowledgedAgentsByPaneKey: { [tabKey]: 300 },
      activityClearedAtByPaneKey: { [tabKey]: 500 }
    })
  }
  carryChatReadMarks(storeOver(state), chatReadMarkRecordsCarriedHere(true))
  expect(state.current.acknowledgedAgentsByPaneKey).toEqual({ [tabKey]: 300 })
  expect(state.current.activityClearedAtByPaneKey).toEqual({
    [tabKey]: 500,
    [CONVERSATION_KEY]: 500
  })
})

it('removes a carried acknowledgement an older build un-acknowledged under the tab key', () => {
  const tabKey = `agent-chat-tab-v1-abc:${LEAF}`
  const state = {
    current: chatTabState('agent-chat-tab-v1-abc', {
      // After a downgrade, Mark unread deleted the tab-keyed acknowledgement and stamped the turn.
      acknowledgedAgentsByPaneKey: { [CONVERSATION_KEY]: 300 },
      manuallyUnreadTurnsByPaneKey: { [tabKey]: 290 },
      chatReadMarksCarriedFrom: { [`acknowledgedAgentsByPaneKey ${tabKey}`]: 300 }
    })
  }
  carryChatReadMarks(storeOver(state), chatReadMarkRecordsCarriedHere(false))
  expect(state.current.acknowledgedAgentsByPaneKey).toEqual({})
  expect(state.current.manuallyUnreadTurnsByPaneKey).toEqual({
    [tabKey]: 290,
    [CONVERSATION_KEY]: 290
  })
})
