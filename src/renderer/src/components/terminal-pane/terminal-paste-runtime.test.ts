import { describe, expect, it } from 'vitest'
import type { WorktreeRuntimeOwnerState } from '@/lib/worktree-runtime-owner-state'
import { resolveTerminalPasteRuntimeEnvironmentId } from './terminal-paste-runtime'

describe('terminal paste runtime', () => {
  it('uploads to the server a PTY id names, even when two hosts publish the workspace', () => {
    const twin: WorktreeRuntimeOwnerState = {
      settings: { activeRuntimeEnvironmentId: null },
      repos: [
        { id: 'twin', connectionId: null, executionHostId: 'local' },
        { id: 'twin', connectionId: null, executionHostId: 'runtime:env-b' }
      ],
      worktreesByRepo: {
        twin: [
          { id: 'twin::/w', repoId: 'twin', hostId: 'local' },
          { id: 'twin::/w', repoId: 'twin', hostId: 'runtime:env-b' }
        ]
      }
    }
    expect(
      resolveTerminalPasteRuntimeEnvironmentId(twin, 'twin::/w', {
        getPtyId: () => 'remote:env-b@@pty-1'
      })
    ).toBe('env-b')
    expect(
      resolveTerminalPasteRuntimeEnvironmentId(twin, 'twin::/w', { getPtyId: () => 'pty-1' })
    ).toBeNull()
  })
})
