import { expect, it } from 'vitest'
import { carriedChatReadMarks } from './chat-read-mark-carry'

const LEAF = '2b8ea975-8113-41ae-a25c-feb50cbe084a'

it('carries a replaced chat’s saved read marks to its conversation key and keeps the originals', () => {
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
    acknowledgedAgentsByPaneKey: {
      [tabKey]: 100,
      [`structured-agent-session-sess-2:${LEAF}`]: 100
    },
    activityClearedAtByPaneKey: {
      [tabKey]: 200,
      [`structured-agent-session-sess-2:${LEAF}`]: 200
    }
  })
})
