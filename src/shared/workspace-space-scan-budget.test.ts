import { describe, expect, it } from 'vitest'
import {
  collectWorkspaceSpaceDirectoryEntries,
  createWorkspaceSpaceScanBudget,
  estimateWorkspaceSpaceEntryRetainedBytes,
  WorkspaceSpaceScanCapacityError
} from './workspace-space-scan-budget'

describe('workspace space scan budget', () => {
  it('preserves entries exactly at the retained-byte cap', async () => {
    const entries = [{ name: 'first' }, { name: 'second' }]
    const parentPath = '/workspace'
    const exactBytes = entries.reduce(
      (total, entry) => total + estimateWorkspaceSpaceEntryRetainedBytes(parentPath, entry.name),
      0
    )

    await expect(
      collectWorkspaceSpaceDirectoryEntries(
        entries,
        parentPath,
        (entry) => entry.name,
        createWorkspaceSpaceScanBudget({ maxRetainedBytes: exactBytes }),
        () => undefined
      )
    ).resolves.toEqual(entries)
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
