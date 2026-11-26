import { expect, it } from 'vitest'
import {
  copyWebClientChatReadMarksForTabLists,
  copyWebClientChatReadMarksOnce
} from './chat-read-mark-web-copy'
import { chatPaneKey } from '../../../../../../shared/agent-session/view/structured-agent-session-projection'

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

it('does not enumerate unchanged deliveries after a copy completed', () => {
  const state: Parameters<typeof copyWebClientChatReadMarksOnce>[0] = {
    activityClearedAtByPaneKey: {},
    manuallyUnreadTurnsByPaneKey: { [OLD_TAB_KEY]: 70 },
    chatReadMarksCopiedHere: true
  }
  for (let index = 0; index < 100; index++) {
    expect(
      copyWebClientChatReadMarksForTabLists(state, () => {
        throw new Error('should not enumerate')
      }, ['w1'])
    ).toBeNull()
  }
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
    ...copyWebClientChatReadMarksForTabLists(state, () => tabs, ['w1'])
  }
  state = {
    ...state,
    ...copyWebClientChatReadMarksForTabLists(state, () => tabs, ['w1'], ['w1'])
  }

  expect(state).toEqual({
    activityClearedAtByPaneKey: {},
    manuallyUnreadTurnsByPaneKey: { [OLD_TAB_KEY]: 70, [CONVERSATION_KEY]: 70 },
    chatReadMarksCopiedHere: true
  })
})

it('completes a delayed first inventory workspace when its replacement arrives', () => {
  let state: Parameters<typeof copyWebClientChatReadMarksOnce>[0] = {
    activityClearedAtByPaneKey: {},
    manuallyUnreadTurnsByPaneKey: { [OLD_TAB_KEY]: 70 },
    chatReadMarksCopiedHere: false
  }
  const tabs = {
    w1: [{ contentType: 'terminal' }],
    w2: [{ contentType: 'agent-session', entityId: 'sess-2' }]
  }

  state = {
    ...state,
    ...copyWebClientChatReadMarksForTabLists(state, () => tabs, ['w1'], ['w1', 'w2'])
  }
  expect(state.chatReadMarksCopiedHere).toBe(false)
  state = {
    ...state,
    ...copyWebClientChatReadMarksForTabLists(state, () => tabs, ['w2'])
  }

  expect(state.manuallyUnreadTurnsByPaneKey[CONVERSATION_KEY]).toBe(70)
  expect(state.chatReadMarksCopiedHere).toBe(true)
})

it('discharges pending workspaces without reading unchanged tabs', () => {
  const state: Parameters<typeof copyWebClientChatReadMarksOnce>[0] = {
    activityClearedAtByPaneKey: {},
    manuallyUnreadTurnsByPaneKey: {},
    chatReadMarksCopiedHere: false
  }

  expect(
    copyWebClientChatReadMarksForTabLists(
      state,
      () => ({ w1: [{ contentType: 'terminal' }] }),
      ['w1'],
      ['w1', 'w2']
    )
  ).toBeNull()
  expect(copyWebClientChatReadMarksForTabLists(state, undefined, ['w2'])).toEqual({
    chatReadMarksCopiedHere: true
  })
})

it('remembers only copied chats and releases migration bookkeeping after completion', () => {
  const sessionId = 'sess-3'
  const conversationKey = chatPaneKey(sessionId)
  const oldKey = `agent-chat-tab-v1-reopened:${conversationKey.slice(conversationKey.lastIndexOf(':') + 1)}`
  let state: Parameters<typeof copyWebClientChatReadMarksOnce>[0] = {
    activityClearedAtByPaneKey: { [oldKey]: 90 },
    manuallyUnreadTurnsByPaneKey: {},
    chatReadMarksCopiedHere: false
  }
  const tabs = { w1: [{ contentType: 'agent-session', entityId: sessionId }] }
  state = { ...state, ...copyWebClientChatReadMarksForTabLists(state, () => tabs, ['w1']) }
  state = {
    ...state,
    activityClearedAtByPaneKey: { [oldKey]: 90 }
  }
  const copiedActivity = state.activityClearedAtByPaneKey
  for (let index = 0; index < 100; index++) {
    expect(copyWebClientChatReadMarksForTabLists(state, () => tabs, ['w1'])).toBeNull()
  }
  expect(copyWebClientChatReadMarksForTabLists(state, () => ({}), ['terminal-only'])).toBeNull()
  expect(state.activityClearedAtByPaneKey).toBe(copiedActivity)

  state = {
    ...state,
    ...copyWebClientChatReadMarksForTabLists(state, () => tabs, ['w1'], ['w1'])
  }
  expect(state.chatReadMarksCopiedHere).toBe(true)

  const restartedState: Parameters<typeof copyWebClientChatReadMarksOnce>[0] = {
    activityClearedAtByPaneKey: { [oldKey]: 91 },
    manuallyUnreadTurnsByPaneKey: {},
    chatReadMarksCopiedHere: false
  }
  expect(copyWebClientChatReadMarksForTabLists(restartedState, () => tabs, ['w1'])).toEqual({
    activityClearedAtByPaneKey: { [oldKey]: 91, [conversationKey]: 91 }
  })
})
