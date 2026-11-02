import { describe, expect, it, vi } from 'vitest'

import type { AgentStatusObservation } from '../../../shared/agent-status-observation'

const { setAgentStatusMock } = vi.hoisted(() => ({ setAgentStatusMock: vi.fn() }))

vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ setAgentStatus: setAgentStatusMock }) }
}))
vi.mock('./agent-status-connection-ownership', () => ({
  resolveLiveAgentStatusConnectionRouting: () => ({ connectionId: null })
}))

describe('renderer-side observation origins', () => {
  it('tags renderer-parsed OSC 9999 rows as osc-origin under the renderer authority', async () => {
    setAgentStatusMock.mockReset()
    const { createBackgroundAgentStatusConsumer } =
      await import('./background-agent-status-consumer')
    const paneKey = 'tab-osc:99999999-9999-4999-8999-999999999999'
    const consumer = createBackgroundAgentStatusConsumer({
      paneKey,
      launchToken: 'launch-1',
      // Why: main parses OSC for local/SSH PTYs; only when it does not is the renderer the authority.
      mainOwnsAgentStatusWrites: false,
      expectedConnectionId: null,
      runtimeEnvironmentId: 'env-1',
      getPtyId: () => 'pty-1'
    })

    consumer.consume(`\x1b]9999;{"state":"working","prompt":"remote turn"}\x07`)
    consumer.consume(`\x1b]9999;{"state":"done","prompt":"remote turn"}\x07`)

    expect(setAgentStatusMock).toHaveBeenCalledTimes(2)
    const observations = setAgentStatusMock.mock.calls.map(
      (call) => (call[1] as { observation?: AgentStatusObservation }).observation
    )
    for (const observation of observations) {
      expect(observation).toMatchObject({
        origin: 'osc',
        kind: 'snapshot',
        authorityId: expect.stringMatching(/^renderer:/)
      })
    }
    expect(observations[1]!.revision).toBeGreaterThan(observations[0]!.revision)
  })
})
