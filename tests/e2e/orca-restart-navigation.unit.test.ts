import { describe, expect, it } from 'vitest'
import { readRestartRendererState } from './helpers/orca-restart'

describe('restart renderer state polling', () => {
  it('treats document replacement as pending state', async () => {
    await expect(
      readRestartRendererState(async () => {
        throw new Error('Execution context was destroyed, most likely because of a navigation.')
      })
    ).resolves.toBeNull()
  })

  it('does not hide non-navigation renderer failures', async () => {
    await expect(
      readRestartRendererState(async () => {
        throw new Error('fetchWorktrees failed')
      })
    ).rejects.toThrow('fetchWorktrees failed')
  })
})
