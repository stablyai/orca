import { describe, expect, it } from 'vitest'
import type { RuntimeTerminalListResult } from '../../../src/shared/runtime-types'
import { readFreshTerminalInventory } from './terminal-inventory-observation'

const listed: RuntimeTerminalListResult = { terminals: [], totalCount: 0, truncated: false }

describe('readFreshTerminalInventory', () => {
  it('returns the inventory the host answered with', async () => {
    await expect(readFreshTerminalInventory(async () => listed)).resolves.toBe(listed)
  })

  // Retry first-mount adoption refusals; throwing from expect.poll would abort instead (CI 39256965951).
  it.each(['terminal_liveness_unavailable', 'terminal_surface_ownership_unavailable'])(
    'treats %s as no observation yet',
    async (refusal) => {
      await expect(
        readFreshTerminalInventory(async () => {
          throw new Error(refusal)
        })
      ).resolves.toBeNull()
    }
  )

  it('rethrows any other failure', async () => {
    await expect(
      readFreshTerminalInventory(async () => {
        throw new Error('terminal_handle_stale')
      })
    ).rejects.toThrow('terminal_handle_stale')
  })
})
