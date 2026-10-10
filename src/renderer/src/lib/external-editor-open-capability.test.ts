import { describe, expect, it } from 'vitest'
import { getExternalEditorOpenCapability } from './external-editor-open-capability'

describe('getExternalEditorOpenCapability', () => {
  it('allows every configured launcher for local paths', () => {
    expect(
      getExternalEditorOpenCapability({ connectionId: null, command: 'cursor --new-window' })
    ).toEqual({ allowed: true, remote: false })
  })

  it('allows supported VS Code commands for SSH paths', () => {
    expect(
      getExternalEditorOpenCapability({ connectionId: 'ssh-1', command: 'code-insiders' })
    ).toEqual({ allowed: true, remote: true })
  })

  it('rejects non-VS Code and compound commands for SSH paths', () => {
    expect(getExternalEditorOpenCapability({ connectionId: 'ssh-1', command: 'cursor' })).toEqual({
      allowed: false,
      reason: 'local-only-editor'
    })
    expect(
      getExternalEditorOpenCapability({ connectionId: 'ssh-1', command: 'code --reuse-window' })
    ).toEqual({ allowed: false, reason: 'local-only-editor' })
  })

  it('ignores which server is focused: only the path owner decides', () => {
    expect(getExternalEditorOpenCapability({ connectionId: 'ssh-1', command: 'code' })).toEqual({
      allowed: true,
      remote: true
    })
  })
  it.each(['zed', 'code', 'code --reuse-window'])(
    'rejects a managed owner while the desktop is focused: %s',
    (command) => {
      expect(
        getExternalEditorOpenCapability({
          command,
          connectionId: null,
          runtimeEnvironmentId: 'managed-owner'
        })
      ).toEqual({ allowed: false, reason: 'remote-runtime' })
    }
  )
})
