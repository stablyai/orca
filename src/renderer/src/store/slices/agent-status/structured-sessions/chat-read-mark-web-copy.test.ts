import { expect, it } from 'vitest'
import type { Tab } from '../../../../../../shared/workspace-layout/tab-groups/tab-types'
import { copyWebClientChatReadMarks } from './chat-read-mark-web-copy'

const LEAF = '2b8ea975-8113-41ae-a25c-feb50cbe084a'
const OLD_TAB_KEY = `agent-chat-tab-v1-abc:${LEAF}`
const OTHER_OLD_TAB_KEY = `structured-agent-session-old:${LEAF}`
const CONVERSATION_KEY = `structured-agent-session-sess-2:${LEAF}`
const chatTab = (id: string): Tab => ({
  id,
  entityId: 'sess-2',
  groupId: 'g',
  worktreeId: 'wt',
  contentType: 'agent-session',
  label: 'Chat',
  customLabel: null,
  color: null,
  sortOrder: 0,
  createdAt: 0
})

it('copies a conversation’s tab-keyed marks once, whatever tab ids or order its tabs arrive with', () => {
  let state: Record<
    'activityClearedAtByPaneKey' | 'manuallyUnreadTurnsByPaneKey' | 'chatReadMarkKeysCopiedHere',
    Record<string, number>
  > = {
    activityClearedAtByPaneKey: { [OLD_TAB_KEY]: 50, [OTHER_OLD_TAB_KEY]: 60 },
    manuallyUnreadTurnsByPaneKey: { [OLD_TAB_KEY]: 70 },
    chatReadMarkKeysCopiedHere: {}
  }
  // After a reload the browser names the tab by the conversation, not the old tab id.
  state = {
    ...state,
    ...copyWebClientChatReadMarks(state, [chatTab('structured-agent-session-sess-2')])
  }
  expect(state.activityClearedAtByPaneKey).toEqual({
    [OLD_TAB_KEY]: 50,
    [OTHER_OLD_TAB_KEY]: 60,
    [CONVERSATION_KEY]: 60
  })
  expect(state.manuallyUnreadTurnsByPaneKey).toEqual({ [OLD_TAB_KEY]: 70, [CONVERSATION_KEY]: 70 })

  // The user clears both; another tab on the same chat arriving later must not fill them back.
  state = {
    ...state,
    activityClearedAtByPaneKey: { [OLD_TAB_KEY]: 50, [OTHER_OLD_TAB_KEY]: 60 },
    manuallyUnreadTurnsByPaneKey: { [OLD_TAB_KEY]: 70 }
  }
  expect(copyWebClientChatReadMarks(state, [chatTab('agent-chat-tab-v1-abc')])).toBeNull()
})
