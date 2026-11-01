import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestStore } from './store-test-helpers'

const PANE_KEY = 'tab-1:11111111-1111-4111-8111-111111111111'
const NOW = Date.UTC(2026, 9, 25, 12)

afterEach(() => vi.useRealTimers())

// #30589: a nested agent's row arrived while the owner idled; the owner's next hook must land.
function reclaim(session?: string) {
  const store = createTestStore()
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  store
    .getState()
    .setAgentStatus(PANE_KEY, { state: 'working', prompt: 'Background job', agentType: 'claude' })
  store.getState().setAgentStatus(
    PANE_KEY,
    { state: 'working', prompt: 'Next task', agentType: 'codex' },
    undefined,
    { updatedAt: NOW + 1 },
    undefined,
    session
      ? {
          paneOwner: { agent: 'codex', session: 'owner' },
          providerSession: { key: 'session_id', id: session }
        }
      : undefined
  )
  return store.getState().agentStatusByPaneKey[PANE_KEY]
}

describe('pane owner reclaim', () => {
  it("accepts the owner's hook over a fresh nested-agent row", () => {
    expect(reclaim('owner')).toMatchObject({
      agentType: 'codex',
      prompt: 'Next task'
    })
  })

  it.each([undefined, 'nested-exec'])('suppresses a different agent from session %s', (session) => {
    expect(reclaim(session)).toMatchObject({ agentType: 'claude', prompt: 'Background job' })
  })
})
