import { describe, expect, it } from 'vitest'
import { resolveWorktreeCreateBaseBranch } from './worktree-create-base'

describe('resolveWorktreeCreateBaseBranch', () => {
  it('uses an explicit Start-from selection', async () => {
    await expect(
      resolveWorktreeCreateBaseBranch({
        explicitBaseBranch: ' origin/feature '
      })
    ).resolves.toBe('origin/feature')
  })

  it('omits repo defaults so backend create owns base selection', async () => {
    await expect(
      resolveWorktreeCreateBaseBranch({
        explicitBaseBranch: undefined
      })
    ).resolves.toBeUndefined()
  })

  it('omits blank explicit selections', async () => {
    await expect(
      resolveWorktreeCreateBaseBranch({
        explicitBaseBranch: '   '
      })
    ).resolves.toBeUndefined()
  })
})
