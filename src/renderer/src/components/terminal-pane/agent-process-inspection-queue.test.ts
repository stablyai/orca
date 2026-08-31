import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  enqueueAgentProcessInspection,
  resetAgentProcessInspectionQueueForTests
} from './agent-process-inspection-queue'

describe('agent process inspection queue', () => {
  afterEach(() => {
    resetAgentProcessInspectionQueueForTests()
    vi.restoreAllMocks()
  })

  it('contains rejected fire-and-forget inspections', async () => {
    const completed = vi.fn()
    enqueueAgentProcessInspection({
      priority: 'cadence',
      run: () => Promise.reject(new Error('remote runtime unavailable'))
    })
    enqueueAgentProcessInspection({
      priority: 'cadence',
      run: async () => completed()
    })

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(completed).toHaveBeenCalledTimes(1)
  })
})
