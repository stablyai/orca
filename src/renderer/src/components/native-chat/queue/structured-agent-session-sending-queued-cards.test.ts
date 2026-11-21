import { expect, it } from 'vitest'
import type { AgentSessionQueuedMessage } from '../../../../../shared/agent-session/requests/agent-session-queued-message-wire'
import { projectQueuedMessageCards } from '../../../../../shared/agent-session/view/structured-agent-session-queued-cards'
import { steeringQueuedMessageEchoes } from './structured-agent-session-sending-queued-cards'

const message = (messageId: string, text: string, steers?: true): AgentSessionQueuedMessage => ({
  messageId,
  position: messageId === 'steer' ? 2 : 1,
  body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] },
  state: 'waiting',
  ...(steers ? { steers } : {})
})

const queued = [message('queued', 'later'), message('steer', 'now', true)]

it('draws a steer the running turn has yet to take in as a sent message, not a queued card', () => {
  const working = { agentWorking: true, queuePaused: false }
  expect(
    projectQueuedMessageCards(queued, [], { ...working, steersInTranscript: true }).map(
      (card) => card.messageId
    )
  ).toEqual(['queued'])
  expect(steeringQueuedMessageEchoes(queued, [], [], working)).toEqual([
    {
      clientMessageId: 'steer',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'now' }] },
      queuedAt: null,
      phase: 'recorded'
    }
  ])

  // After a Stop the steer waits like any card, where Send can still reach it.
  const paused = { agentWorking: true, queuePaused: true }
  expect(
    projectQueuedMessageCards(queued, [], { ...paused, steersInTranscript: true }).map(
      (card) => card.messageId
    )
  ).toEqual(['queued', 'steer'])
  expect(steeringQueuedMessageEchoes(queued, [], [], paused)).toEqual([])
})
