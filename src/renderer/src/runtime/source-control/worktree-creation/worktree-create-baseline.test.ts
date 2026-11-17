import { expect, it } from 'vitest'
import { resolveWorktreeCreateBaseBranch } from './worktree-create-base'

it.each([undefined, '', '   '])(
  'refuses workspace creation without an explicit baseline (%s)',
  async (explicitBaseBranch) => {
    await expect(resolveWorktreeCreateBaseBranch({ explicitBaseBranch })).rejects.toThrow(
      'Select a baseline branch before creating a workspace.'
    )
  }
)
