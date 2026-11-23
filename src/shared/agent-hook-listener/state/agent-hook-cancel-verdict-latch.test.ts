import { describe, expect, it, vi } from 'vitest'

import {
  createAgentStatusExtensionHarness,
  type AgentStatusExtensionHarness
} from '../../../main/pi/managed-extensions/agent-status/agent-status-extension-test-harness'
import { startAsync } from '../../../main/pi/managed-extensions/agent-status/agent-status-subagent-event-fixtures'
import type { AgentHookEventPayload } from '../listener-event'
import { createHookListenerState } from '../listener-state'
import { normalizeHookPayload } from '../normalization/normalize-hook-payload'
import { resolveCancelVerdictLatch } from './agent-hook-cancel-verdict-latch'

const PANE_KEY = 'tab-1:11111111-1111-4111-8111-111111111111'
const CANCELLED_AT = 1_000_000

const cancelledPiRow = {
  paneKey: PANE_KEY,
  connectionId: null,
  hookEventName: 'agent_end',
  receivedAt: CANCELLED_AT,
  payload: { state: 'done', interrupted: true, prompt: '', agentType: 'pi' }
} satisfies AgentHookEventPayload & { receivedAt: number }

async function normalizedStart(
  emit: (harness: AgentStatusExtensionHarness) => void
): Promise<AgentHookEventPayload> {
  const harness = createAgentStatusExtensionHarness({
    kind: 'pi',
    env: { ORCA_PANE_KEY: PANE_KEY }
  })
  emit(harness)
  await vi.waitFor(() => expect(harness.fetchMock).toHaveBeenCalledTimes(1))
  const body: unknown = JSON.parse(String(harness.fetchMock.mock.calls[0]?.[1]?.body))
  const event = normalizeHookPayload(createHookListenerState(), 'pi', body, 'env-1')
  if (!event) {
    throw new Error('expected the start post to normalize')
  }
  return event
}

describe('resolveCancelVerdictLatch after a Pi cancel', () => {
  const withinWindow = CANCELLED_AT + 5_000

  it('applies only a live background subagent start within the window', async () => {
    const backgroundStart = await normalizedStart((harness) =>
      startAsync(harness, 'bg-1', 'uploader')
    )
    expect(resolveCancelVerdictLatch(cancelledPiRow, backgroundStart, withinWindow)).toEqual({
      hold: false,
      event: backgroundStart
    })

    // An OMP lifecycle start may belong to the cancelled turn, so it stays held.
    const lifecycleStart = await normalizedStart((harness) =>
      harness.emitPiEvent('task:subagent:lifecycle', { id: 'task-1', status: 'started' })
    )
    expect(resolveCancelVerdictLatch(cancelledPiRow, lifecycleStart, withinWindow)).toEqual({
      hold: true
    })

    const replayedStart = { ...backgroundStart, isReplay: true }
    expect(resolveCancelVerdictLatch(cancelledPiRow, replayedStart, withinWindow)).toEqual({
      hold: true
    })
  })
})
