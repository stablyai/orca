import { expect, it } from 'vitest'
import { getCreationProgressLabel, type PendingWorktreeCreation } from './pending-worktree-creation'

const t = ((_key: string, fallback: string) => fallback) as Parameters<
  typeof getCreationProgressLabel
>[1]

function label(
  provider: 'orca-cloud' | undefined,
  environmentCheck?: PendingWorktreeCreation['environmentCheck']
): string {
  return getCreationProgressLabel(
    {
      status: 'creating',
      phase: 'provisioning-vm',
      indeterminate: false,
      environmentCheck,
      request: {
        name: 'fix-login',
        ephemeralVmRecipe: { sourceRepoId: 'r', recipeId: 'cloud', projectId: 'p', provider }
      } as PendingWorktreeCreation['request']
    },
    t
  )
}

it('speaks of a sandbox for Orca Cloud and keeps VM wording for bring-your-own recipes', () => {
  expect(label('orca-cloud')).toBe('Starting sandbox…')
  expect(
    label('orca-cloud', {
      status: 'running',
      startedAt: 1
    } as PendingWorktreeCreation['environmentCheck'])
  ).toBe('Preparing environment…')
  expect(label(undefined)).toBe('Provisioning VM…')
})
