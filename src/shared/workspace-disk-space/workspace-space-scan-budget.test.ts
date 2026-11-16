import { describe, expect, it } from 'vitest'
import {
  collectWorkspaceSpaceDirectoryEntries,
  createWorkspaceSpaceScanBudget,
  WorkspaceSpaceScanCapacityError
} from './workspace-space-scan-budget'

describe('workspace space scan budget', () => {
  it('returns a failed listing’s charge so it cannot leak across directories', async () => {
    const budget = createWorkspaceSpaceScanBudget()
    async function* directory() {
      yield { name: 'accepted' }
      throw new Error('readdir exploded')
    }

    await expect(
      collectWorkspaceSpaceDirectoryEntries(
        directory(),
        '/workspace',
        (entry) => entry.name,
        budget,
        () => undefined
      )
    ).rejects.toThrow('readdir exploded')
    expect(budget).toMatchObject({ retainedBytes: 0 })
  })

  it('closes an async directory iterator when the next entry exceeds the budget', async () => {
    let closed = false
    async function* directory() {
      try {
        yield { name: 'accepted' }
        yield { name: 'overflow' }
      } finally {
        closed = true
      }
    }

    await expect(
      collectWorkspaceSpaceDirectoryEntries(
        directory(),
        '/workspace',
        (entry) => entry.name,
        createWorkspaceSpaceScanBudget({ maxEntries: 1 }),
        () => undefined
      )
    ).rejects.toBeInstanceOf(WorkspaceSpaceScanCapacityError)
    expect(closed).toBe(true)
  })
})
