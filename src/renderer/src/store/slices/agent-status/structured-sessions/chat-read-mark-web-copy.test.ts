import { expect, it } from 'vitest'
import { copyWebClientChatReadMarksOnce } from './chat-read-mark-web-copy'

const LEAF = '2b8ea975-8113-41ae-a25c-feb50cbe084a'
const OLD_TAB_KEY = `agent-chat-tab-v1-abc:${LEAF}`
const OTHER_OLD_TAB_KEY = `structured-agent-session-old:${LEAF}`
const CONVERSATION_KEY = `structured-agent-session-sess-2:${LEAF}`

it('copies a web client’s tab-keyed marks to the conversation key once, and never again', () => {
  let state = {
    activityClearedAtByPaneKey: { [OLD_TAB_KEY]: 50, [OTHER_OLD_TAB_KEY]: 60 } as Record<
      string,
      number
    >,
    manuallyUnreadTurnsByPaneKey: { [OLD_TAB_KEY]: 70 } as Record<string, number>,
    chatReadMarksCopiedHere: false
  }
  state = { ...state, ...copyWebClientChatReadMarksOnce(state, ['sess-2']) }
  expect(state).toEqual({
    activityClearedAtByPaneKey: {
      [OLD_TAB_KEY]: 50,
      [OTHER_OLD_TAB_KEY]: 60,
      [CONVERSATION_KEY]: 60
    },
    manuallyUnreadTurnsByPaneKey: { [OLD_TAB_KEY]: 70, [CONVERSATION_KEY]: 70 },
    chatReadMarksCopiedHere: true
  })

  // The user clears the copies; a later tab list must not fill them back.
  state = {
    ...state,
    activityClearedAtByPaneKey: { [OLD_TAB_KEY]: 50, [OTHER_OLD_TAB_KEY]: 60 },
    manuallyUnreadTurnsByPaneKey: { [OLD_TAB_KEY]: 70 }
  }
  expect(copyWebClientChatReadMarksOnce(state, ['sess-2'])).toBeNull()
})
