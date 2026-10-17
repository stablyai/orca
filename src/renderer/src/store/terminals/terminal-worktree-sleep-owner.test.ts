import { describe, expect, it } from 'vitest'
import { toRemoteRuntimePtyId } from '../../../../shared/remote-runtime-pty-id'
import type { WorktreeOperationRouteState } from '@/lib/worktree-operation-route'
import { resolveTerminalWorktreeSleepOwner } from './terminal-worktree-sleep-owner'

describe('terminal workspace sleep owner', () => {
  it('uses the PTY owner when another host with the same workspace id is selected', () => {
    const state = {
      activeWorktreeId: 'same-workspace',
      activeWorkspaceExecutionHostId: 'runtime:env-b'
    } satisfies WorktreeOperationRouteState
    expect(
      resolveTerminalWorktreeSleepOwner(
        state,
        'same-workspace',
        toRemoteRuntimePtyId('pty-1', 'env-a')
      )
    ).toBe('runtime:env-a')
    expect(
      resolveTerminalWorktreeSleepOwner(state, 'same-workspace', toRemoteRuntimePtyId('pty-1'))
    ).toBeNull()
  })
})
