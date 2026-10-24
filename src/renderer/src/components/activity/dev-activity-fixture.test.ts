import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parsePaneKey } from '../../../../shared/stable-pane-id'

const mocks = vi.hoisted(() => ({
  getState: vi.fn(),
  setState: vi.fn(),
  setAgentStatuses: vi.fn()
}))

vi.mock('@/store', async () => {
  const { withAgentStatusFixture } = await import('@/store/slices/store-test-helpers')

  const fixture = {
    useAppStore: {
      getState: mocks.getState,
      setState: mocks.setState
    }
  }
  const readFixture = fixture.useAppStore.getState

  return withAgentStatusFixture(fixture, () => readFixture() ?? {})
})

import { seedDevActivityFixture } from './dev-activity-fixture'

describe('seedDevActivityFixture', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getState.mockReturnValue({
      repos: [],
      agentStatusByPaneKey: {},
      setAgentStatuses: mocks.setAgentStatuses
    })
  })

  it('seeds locally-owned rows with valid stable pane keys', () => {
    seedDevActivityFixture()

    const updates = mocks.setAgentStatuses.mock.calls[0]?.[0] ?? []
    expect(updates).toHaveLength(3)
    for (const update of updates) {
      expect(parsePaneKey(update.paneKey)).not.toBeNull()
      expect(update.routing.connectionId).toBeNull()
    }
  })
})
