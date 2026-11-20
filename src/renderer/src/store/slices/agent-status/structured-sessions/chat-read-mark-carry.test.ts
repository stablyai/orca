import { expect, it } from 'vitest'
import type { AppState } from '../../../types'
import { carriedChatReadMarks, carryChatReadMarks } from './chat-read-mark-carry'

const LEAF = '2b8ea975-8113-41ae-a25c-feb50cbe084a'

it('moves a replaced chat’s saved read marks to its conversation key, once', () => {
  const tabKey = `structured-agent-session-old:${LEAF}`
  const patch = carriedChatReadMarks(
    {
      acknowledgedAgentsByPaneKey: { [tabKey]: 100 },
      activityClearedAtByPaneKey: { [tabKey]: 200 },
      manuallyUnreadTurnsByPaneKey: {}
    },
    [{ id: 'structured-agent-session-old', contentType: 'agent-session', entityId: 'sess-2' }]
  )
  expect(patch).toEqual({
    acknowledgedAgentsByPaneKey: { [`structured-agent-session-sess-2:${LEAF}`]: 100 },
    activityClearedAtByPaneKey: { [`structured-agent-session-sess-2:${LEAF}`]: 200 }
  })
  // Marking it unread later deletes the conversation key; nothing is left to carry back.
  expect(
    carriedChatReadMarks(
      {
        acknowledgedAgentsByPaneKey: {},
        activityClearedAtByPaneKey: patch?.activityClearedAtByPaneKey ?? {},
        manuallyUnreadTurnsByPaneKey: {}
      },
      [{ id: 'structured-agent-session-old', contentType: 'agent-session', entityId: 'sess-2' }]
    )
  ).toBeNull()
})

it('moves a reopened chat tab’s saved read marks too', () => {
  let state: Pick<
    AppState,
    | 'unifiedTabsByWorktree'
    | 'acknowledgedAgentsByPaneKey'
    | 'activityClearedAtByPaneKey'
    | 'manuallyUnreadTurnsByPaneKey'
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
    acknowledgedAgentsByPaneKey: {},
    activityClearedAtByPaneKey: { [`agent-chat-tab-v1-abc:${LEAF}`]: 300 },
    manuallyUnreadTurnsByPaneKey: {}
  }
  carryChatReadMarks({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the carry reads only these four fields.
    getState: () => state as AppState,
    setState: (patch) => {
      state = { ...state, ...patch }
    }
  })
  expect(state.activityClearedAtByPaneKey).toEqual({
    [`structured-agent-session-sess-2:${LEAF}`]: 300
  })
})
