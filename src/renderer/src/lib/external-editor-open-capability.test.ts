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

  it('rejects non-VS Code and compound commands for SSH paths', () => {
    expect(
      getExternalEditorOpenCapability(
        { activeRuntimeEnvironmentId: null },
        { connectionId: 'ssh-1', command: 'cursor' }
      )
    ).toEqual({ allowed: false, reason: 'local-only-editor' })
    expect(
      getExternalEditorOpenCapability(
        { activeRuntimeEnvironmentId: null },
        { connectionId: 'ssh-1', command: 'code --reuse-window' }
      )
    ).toEqual({ allowed: false, reason: 'local-only-editor' })
  })

  it('rejects every local-app launch while a remote runtime is active', () => {
    expect(
      getExternalEditorOpenCapability(
        { activeRuntimeEnvironmentId: 'runtime-1' },
        { connectionId: 'ssh-1', command: 'code' }
      )
    ).toEqual({ allowed: false, reason: 'remote-runtime' })
  })
})
