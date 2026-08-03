import { describe, expect, it, vi } from 'vitest'
import { listAllOrchestrationRuns } from './orchestration-run-pages'

describe('orchestration Run pagination compatibility', () => {
  it('stops after an old server response without nextCursor', async () => {
    const call = vi.fn().mockResolvedValue({
      result: { runs: [{ id: 'run_old', objective: 'Old server Run' }] }
    })

    await expect(listAllOrchestrationRuns({ call })).resolves.toEqual([
      { id: 'run_old', objective: 'Old server Run' }
    ])
    expect(call).toHaveBeenCalledTimes(1)
    expect(call).toHaveBeenCalledWith('orchestration.runList', { limit: 100 })
  })
})
