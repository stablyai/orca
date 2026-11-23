import { expect, it } from 'vitest'
import type { Tab } from '../../../../../../shared/workspace-layout/tab-groups/tab-types'
import { copyWebClientChatReadMarks } from './chat-read-mark-web-copy'

const LEAF = '2b8ea975-8113-41ae-a25c-feb50cbe084a'
const TAB_KEY = `agent-chat-tab-v1-abc:${LEAF}`
const CONVERSATION_KEY = `structured-agent-session-sess-2:${LEAF}`
const TAB: Tab = {
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

it('copies a tab-keyed mark at most once, however often its tab is delivered', () => {
  let state: Record<
    'activityClearedAtByPaneKey' | 'manuallyUnreadTurnsByPaneKey' | 'chatReadMarkKeysCopiedHere',
    Record<string, number>
  > = {
    activityClearedAtByPaneKey: { [TAB_KEY]: 50 },
    manuallyUnreadTurnsByPaneKey: { [TAB_KEY]: 70 },
    chatReadMarkKeysCopiedHere: {}
  }
  expect(copyWebClientChatReadMarks(state, [])).toBeNull()
  state = { ...state, ...copyWebClientChatReadMarks(state, [TAB]) }
  expect(state.activityClearedAtByPaneKey).toEqual({ [TAB_KEY]: 50, [CONVERSATION_KEY]: 50 })
  expect(state.manuallyUnreadTurnsByPaneKey).toEqual({ [TAB_KEY]: 70, [CONVERSATION_KEY]: 70 })

  // The user clears both; a later delivery of the same tab must not fill them back.
  state = {
    ...state,
    activityClearedAtByPaneKey: { [TAB_KEY]: 50 },
    manuallyUnreadTurnsByPaneKey: { [TAB_KEY]: 70 }
  }
  expect(copyWebClientChatReadMarks(state, [TAB])).toBeNull()
})
