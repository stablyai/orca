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

  it.each(['cursor', 'zed'])('allows %s for SSH paths', (command) => {
    expect(getExternalEditorOpenCapability({ connectionId: 'ssh-1', command })).toEqual({
      allowed: true,
      remote: true
    })
  })

  it('rejects other and compound commands for SSH paths', () => {
    expect(getExternalEditorOpenCapability({ connectionId: 'ssh-1', command: 'subl' })).toEqual({
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

  it('opens a server workspace through the SSH host that holds it, and only that server', () => {
    const runtimeSshHost = { environmentId: 'managed', sshTargetId: 'box' }
    expect(
      getExternalEditorOpenCapability({
        command: 'code',
        runtimeEnvironmentId: 'managed',
        runtimeSshHost
      })
    ).toEqual({ allowed: true, remote: true, sshTargetId: 'box' })
    expect(
      getExternalEditorOpenCapability({
        command: 'subl',
        runtimeEnvironmentId: 'managed',
        runtimeSshHost
      })
    ).toEqual({ allowed: false, reason: 'local-only-editor' })
    expect(
      getExternalEditorOpenCapability({
        command: 'code',
        runtimeEnvironmentId: 'other',
        runtimeSshHost
      })
    ).toEqual({ allowed: false, reason: 'remote-runtime' })
  })
})
