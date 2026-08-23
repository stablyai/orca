import { describe, expect, it } from 'vitest'
import { getWorkspaceSessionPersistenceHostId } from './workspace-session-persistence-host'

describe('workspace session persistence host', () => {
  it.each([
    ['local worktree', 'local', 'local'],
    ['local folder', 'local', 'local'],
    ['direct SSH worktree', 'ssh:box-a', 'local'],
    ['direct SSH folder', 'ssh:box-b', 'local'],
    ['runtime worktree', 'runtime:env-a', 'runtime:env-a'],
    ['runtime folder', 'runtime:env-b', 'runtime:env-b']
  ] as const)('maps %s execution %s to %s persistence', (_name, executionHostId, expected) => {
    expect(getWorkspaceSessionPersistenceHostId(executionHostId)).toBe(expected)
  })
})
