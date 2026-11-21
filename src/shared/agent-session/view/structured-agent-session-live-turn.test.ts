import { expect, it } from 'vitest'
import type { AgentSessionSubscribeEvent } from '../agent-session-wire'
import {
  actionablePromptIdsAfterStructuredAgentSessionBatch,
  latestTurnAfterStructuredAgentSessionBatch
} from './structured-agent-session-live-turn'

it('keeps the host facts a streaming window restates unchanged, so views memoized on them hold', () => {
  const latestTurn = { itemId: 'turn', turn: { state: 'running' } }
  const actionablePromptIds = ['prompt']
  const restated = {
    type: 'batch',
    sessionId: 's',
    // Decoded from the wire, so every window carries new objects with the same values.
    latestTurn: structuredClone(latestTurn),
    actionablePromptIds: structuredClone(actionablePromptIds),
    batch: { cursor: { epoch: 'e', sequence: 1 }, items: [{}], removedItemIds: [], submissions: [] }
  } as unknown as Extract<AgentSessionSubscribeEvent, { type: 'batch' }>
  const previousTurn = latestTurn as unknown as Parameters<
    typeof latestTurnAfterStructuredAgentSessionBatch
  >[0]
  expect(latestTurnAfterStructuredAgentSessionBatch(previousTurn, restated)).toBe(previousTurn)
  expect(actionablePromptIdsAfterStructuredAgentSessionBatch(actionablePromptIds, restated)).toBe(
    actionablePromptIds
  )
})
