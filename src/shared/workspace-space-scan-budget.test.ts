import { describe, expect, it } from 'vitest'
import {
  collectWorkspaceSpaceDirectoryEntries,
  createWorkspaceSpaceScanBudget,
  estimateWorkspaceSpaceEntryRetainedBytes,
  estimateWorkspaceSpaceListingRetainedBytes,
  releaseWorkspaceSpaceScanEntries,
  WorkspaceSpaceScanCapacityError
} from './workspace-space-scan-budget'

describe('workspace space scan budget', () => {
  it('preserves entries exactly at the retained-byte cap', async () => {
    const entries = [{ name: 'first' }, { name: 'second' }]
    const parentPath = '/workspace'
    const exactBytes = entries.reduce(
      (total, entry) => total + estimateWorkspaceSpaceEntryRetainedBytes(entry.name),
      estimateWorkspaceSpaceListingRetainedBytes(parentPath)
    )

    await expect(
      collectWorkspaceSpaceDirectoryEntries(
        entries,
        parentPath,
        (entry) => entry.name,
        createWorkspaceSpaceScanBudget({ maxRetainedBytes: exactBytes }),
        () => undefined
      )
    ).resolves.toEqual({ entries, retainedBytes: exactBytes })
  })

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

  it('frees capacity for later directories once a listing is released', async () => {
    const parentPath = '/workspace'
    const entries = [{ name: 'first' }, { name: 'second' }]
    const exactBytes = entries.reduce(
      (total, entry) => total + estimateWorkspaceSpaceEntryRetainedBytes(entry.name),
      estimateWorkspaceSpaceListingRetainedBytes(parentPath)
    )
    const budget = createWorkspaceSpaceScanBudget({ maxRetainedBytes: exactBytes })

    const first = await collectWorkspaceSpaceDirectoryEntries(
      entries,
      parentPath,
      (entry) => entry.name,
      budget,
      () => undefined
    )
    // Why: a cumulative counter would reject the identical second listing here.
    releaseWorkspaceSpaceScanEntries(budget, first.retainedBytes)

    await expect(
      collectWorkspaceSpaceDirectoryEntries(
        entries,
        parentPath,
        (entry) => entry.name,
        budget,
        () => undefined
      )
    ).resolves.toMatchObject({ retainedBytes: exactBytes })
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

  it('reports the configured cap rather than the default limits', async () => {
    await expect(
      collectWorkspaceSpaceDirectoryEntries(
        [{ name: 'first' }, { name: 'second' }],
        '/workspace',
        (entry) => entry.name,
        createWorkspaceSpaceScanBudget({ maxEntries: 1, maxRetainedBytes: 4 * 1024 * 1024 }),
        () => undefined
      )
    ).rejects.toThrow('limit: 1 entries or 4 MiB of live scan state')
  })
})
