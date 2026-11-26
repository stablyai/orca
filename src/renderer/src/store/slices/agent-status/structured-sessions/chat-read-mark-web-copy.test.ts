import { expect, it } from 'vitest'
import {
  copyWebClientChatReadMarksForTabLists,
  copyWebClientChatReadMarksOnce
} from './chat-read-mark-web-copy'

const LEAF = '2b8ea975-8113-41ae-a25c-feb50cbe084a'
const OLD_TAB_KEY = `agent-chat-tab-v1-abc:${LEAF}`
const OTHER_OLD_TAB_KEY = `structured-agent-session-old:${LEAF}`
const CONVERSATION_KEY = `structured-agent-session-sess-2:${LEAF}`

it('copies a web client’s tab-keyed marks to the conversation key once, and never again', () => {
  let state: Parameters<typeof copyWebClientChatReadMarksOnce>[0] = {
    activityClearedAtByPaneKey: { [OLD_TAB_KEY]: 50, [OTHER_OLD_TAB_KEY]: 60 },
    manuallyUnreadTurnsByPaneKey: { [OLD_TAB_KEY]: 70 },
    chatReadMarksCopiedHere: false
  }
  state = { ...state, ...copyWebClientChatReadMarksOnce(state, () => ['sess-2']) }
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
  expect(copyWebClientChatReadMarksOnce(state, () => ['sess-2'])).toBeNull()
})

it('does not complete until a full inventory arrives', () => {
  const state: Parameters<typeof copyWebClientChatReadMarksOnce>[0] = {
    activityClearedAtByPaneKey: {},
    manuallyUnreadTurnsByPaneKey: { [OLD_TAB_KEY]: 70 },
    chatReadMarksCopiedHere: false
  }
  const copied = copyWebClientChatReadMarksOnce(state, () => ['sess-2'], false)

  expect(copied).toEqual({
    manuallyUnreadTurnsByPaneKey: { [OLD_TAB_KEY]: 70, [CONVERSATION_KEY]: 70 }
  })
})

it('does not enumerate when a copy already completed', () => {
  const state: Parameters<typeof copyWebClientChatReadMarksOnce>[0] = {
    activityClearedAtByPaneKey: {},
    manuallyUnreadTurnsByPaneKey: { [OLD_TAB_KEY]: 70 },
    chatReadMarksCopiedHere: true
  }
  expect(
    copyWebClientChatReadMarksForTabLists(
      state,
      () => {
        throw new Error('should not enumerate')
      },
      [],
      true
    )
  ).toBeNull()
})

it('keeps an active-frame copy when its full inventory later arrives stale', () => {
  let state: Parameters<typeof copyWebClientChatReadMarksOnce>[0] = {
    activityClearedAtByPaneKey: {},
    manuallyUnreadTurnsByPaneKey: { [OLD_TAB_KEY]: 70 },
    chatReadMarksCopiedHere: false
  }
  const tabs = {
    w1: [{ contentType: 'agent-session', entityId: 'sess-2' }]
  }

  state = {
    ...state,
    ...copyWebClientChatReadMarksForTabLists(state, () => tabs, ['w1'], false)
  }
  state = {
    ...state,
    ...copyWebClientChatReadMarksForTabLists(state, () => tabs, ['w1'], true)
  }

  expect(state).toEqual({
    activityClearedAtByPaneKey: {},
    manuallyUnreadTurnsByPaneKey: { [OLD_TAB_KEY]: 70, [CONVERSATION_KEY]: 70 },
    chatReadMarksCopiedHere: true
  })
})
