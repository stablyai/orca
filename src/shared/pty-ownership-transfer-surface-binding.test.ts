import { describe, expect, it } from 'vitest'
import type { ExecutionHostId } from './execution-host'
import { parsePtyOwnershipTransferSurfaceBinding } from './pty-ownership-transfer-surface-binding'

const baseBinding = {
  workspaceKey: 'folder:folder-1',
  tabId: 'tab-1',
  leafId: '11111111-1111-4111-8111-111111111111'
}

describe('PTY ownership transfer surface binding', () => {
  it.each([
    ['local', 'terminal-1'],
    ['ssh:ssh-target-1', 'ssh:ssh-target-1@@terminal-1'],
    ['runtime:runtime-1', 'remote:runtime-1@@terminal-1']
  ] satisfies readonly [ExecutionHostId, string][])(
    'accepts an exact %s PTY route',
    (executionHostId, ptyId) => {
      expect(
        parsePtyOwnershipTransferSurfaceBinding({ ...baseBinding, executionHostId, ptyId })
      ).toMatchObject({ executionHostId, ptyId })
    }
  )

  it.each([
    ['local host with runtime PTY', 'local', 'remote:runtime-1@@terminal-1'],
    ['SSH host mismatch', 'ssh:ssh-target-1', 'ssh:ssh-target-2@@terminal-1'],
    ['runtime host mismatch', 'runtime:runtime-1', 'remote:runtime-2@@terminal-1'],
    ['runtime PTY without owner', 'runtime:runtime-1', 'remote:terminal-1']
  ] satisfies readonly [string, ExecutionHostId, string][])(
    'rejects %s',
    (_label, executionHostId, ptyId) => {
      expect(() =>
        parsePtyOwnershipTransferSurfaceBinding({ ...baseBinding, executionHostId, ptyId })
      ).toThrow('pty_ownership_transfer_surface_binding_invalid')
    }
  )
})
