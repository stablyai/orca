import { expect, it } from 'vitest'
import type { AgentSessionLatestTurn, AgentSessionSubscribeEvent } from '../agent-session-wire'
import {
  actionablePromptIdsAfterStructuredAgentSessionBatch,
  latestTurnAfterStructuredAgentSessionBatch
} from './structured-agent-session-live-turn'

it('keeps the host facts a streaming window restates unchanged, so views memoized on them hold', () => {
  const latestTurn: AgentSessionLatestTurn = {
    itemId: 'turn',
    observedAt: 1,
    turn: { turnId: 't', state: 'running' }
  }
  const actionablePromptIds = ['prompt']
  const restated: Extract<AgentSessionSubscribeEvent, { type: 'batch' }> = {
    type: 'batch',
    sessionId: 's',
    // Decoded from the wire, so every window carries new objects with the same values.
    latestTurn: structuredClone(latestTurn),
    actionablePromptIds: structuredClone(actionablePromptIds),
    batch: {
      cursor: { epoch: 'e', sequence: 1 },
      items: [],
      removedItemIds: ['gone'],
      submissions: []
    }
  }
  expect(latestTurnAfterStructuredAgentSessionBatch(latestTurn, restated)).toBe(latestTurn)
  expect(actionablePromptIdsAfterStructuredAgentSessionBatch(actionablePromptIds, restated)).toBe(
    actionablePromptIds
  )
})
