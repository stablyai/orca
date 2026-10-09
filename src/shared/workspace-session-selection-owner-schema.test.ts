import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from './constants'
import { parseWorkspaceSession } from './workspace-session-schema'
import type { WorktreeSelectionOwner } from './worktree-selection-owner'

const owner: WorktreeSelectionOwner = {
  worktreeId: 'repo-1::/workspace/feature',
  publisherHostId: 'runtime:paired-host',
  executionHostId: 'ssh:execution-host',
  instanceId: 'workspace-instance-1'
}

function parseOwner(activeWorkspaceOwner: unknown) {
  return parseWorkspaceSession({
    ...getDefaultWorkspaceSession(),
    activeWorktreeId: owner.worktreeId,
    activeWorkspaceOwner
  })
}

describe('workspace session selection owner schema', () => {
  it.each([owner, { ...owner, instanceId: undefined }, null])(
    'preserves an optional selected owner: %j',
    (activeWorkspaceOwner) => {
      const result = parseOwner(activeWorkspaceOwner)

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.value.activeWorkspaceOwner).toEqual(activeWorkspaceOwner)
      }
    }
  )

  it('accepts an older session without selected-owner proof', () => {
    const result = parseWorkspaceSession(getDefaultWorkspaceSession())

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.activeWorkspaceOwner).toBeUndefined()
    }
  })

  it.each([
    'not-an-owner',
    [],
    {},
    { ...owner, worktreeId: '' },
    { ...owner, publisherHostId: 'unknown-host' },
    { ...owner, executionHostId: 'unknown-host' },
    { ...owner, instanceId: '' },
    { ...owner, instanceId: 1 }
  ])('drops malformed proof without dropping the selected workspace: %j', (invalidOwner) => {
    const result = parseOwner(invalidOwner)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.activeWorkspaceOwner).toBeUndefined()
      expect(result.value.activeWorktreeId).toBe(owner.worktreeId)
    }
  })
})
