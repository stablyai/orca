import { describe, expect, it } from 'vitest'
import { readFreshTerminalInventory } from './terminal-inventory-observation'

describe('readFreshTerminalInventory', () => {
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
