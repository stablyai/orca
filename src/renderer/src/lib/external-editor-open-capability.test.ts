import { describe, expect, it } from 'vitest'
import { getExternalEditorOpenCapability } from './external-editor-open-capability'

describe('getExternalEditorOpenCapability', () => {
  it('allows every configured launcher for local paths', () => {
    expect(
      getExternalEditorOpenCapability(
        { activeRuntimeEnvironmentId: null },
        { connectionId: null, command: 'cursor --new-window' }
      )
    ).toEqual({ allowed: true, remote: false })
  })

  it('allows supported VS Code commands for SSH paths', () => {
    expect(
      getExternalEditorOpenCapability(
        { activeRuntimeEnvironmentId: null },
        { connectionId: 'ssh-1', command: 'code-insiders' }
      )
    ).toEqual({ allowed: true, remote: true })
  })

  it.each(['cursor', 'zed'])('allows %s for SSH paths', (command) => {
    expect(
      getExternalEditorOpenCapability(
        { activeRuntimeEnvironmentId: null },
        { connectionId: 'ssh-1', command }
      )
    ).toEqual({ allowed: true, remote: true })
  })

  it('rejects compound commands for SSH paths', () => {
    expect(
      getExternalEditorOpenCapability(
        { activeRuntimeEnvironmentId: null },
        { connectionId: 'ssh-1', command: 'code --reuse-window' }
      )
    ).toEqual({ allowed: false, reason: 'local-only-editor' })
  })

  it.each(['code', 'code-insiders', 'cursor', 'zed'])(
    'allows the remote-capable launcher %s for a runtime-owned worktree',
    (command) => {
      expect(
        getExternalEditorOpenCapability(
          { activeRuntimeEnvironmentId: null },
          { executionHostId: 'runtime:runtime-1', command }
        )
      ).toEqual({ allowed: true, remote: true })
    }
  )

  it.each(['code --reuse-window', 'zed --new'])(
    'rejects the unsupported runtime launcher %s',
    (command) => {
      expect(
        getExternalEditorOpenCapability(
          { activeRuntimeEnvironmentId: null },
          { executionHostId: 'runtime:runtime-1', command }
        )
      ).toEqual({ allowed: false, reason: 'local-only-editor' })
    }
  )

  it('keeps explicit local ownership local while another runtime is active', () => {
    expect(
      getExternalEditorOpenCapability(
        { activeRuntimeEnvironmentId: 'runtime-1' },
        { executionHostId: 'local', command: 'cursor' }
      )
    ).toEqual({ allowed: true, remote: false })
  })

  it('rejects legacy requests without host provenance while a remote runtime is active', () => {
    expect(
      getExternalEditorOpenCapability(
        { activeRuntimeEnvironmentId: 'runtime-1' },
        { connectionId: 'ssh-1', command: 'code' }
      )
    ).toEqual({ allowed: false, reason: 'remote-runtime' })
  })
})
