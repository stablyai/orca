import { describe, expect, it } from 'vitest'
import {
  getExternalEditorOpenCapability,
  runtimeEnvironmentHasSshAccess
} from './external-editor-open-capability'

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

  it('allows VS Code for a managed server reached over SSH, and no other editor', () => {
    const context = { connectionId: null, runtimeEnvironmentId: 'env-1', runtimeSshAccess: true }
    expect(getExternalEditorOpenCapability({ ...context, command: 'code' })).toEqual({
      allowed: true,
      remote: true
    })
    expect(getExternalEditorOpenCapability({ ...context, command: 'cursor' })).toEqual({
      allowed: false,
      reason: 'local-only-editor'
    })
  })

  it('still refuses an unresolved owner that claims SSH access', () => {
    expect(
      getExternalEditorOpenCapability({
        command: 'code',
        runtimeEnvironmentId: 'env-1',
        runtimeSshAccess: true,
        ownerUnresolved: true
      })
    ).toEqual({ allowed: false, reason: 'remote-runtime' })
  })

  it('reads SSH access from the environment list', () => {
    const link = {
      sshTargetId: 'ssh-1',
      sshTargetGeneration: 1,
      localPort: 1234,
      remotePort: 6768,
      endpointId: 'tunnel',
      previousPreferredEndpointId: 'direct'
    }
    const environments = [{ id: 'env-1', sshAccess: link }, { id: 'env-2' }]
    expect(runtimeEnvironmentHasSshAccess(environments, 'env-1')).toBe(true)
    expect(runtimeEnvironmentHasSshAccess(environments, 'env-2')).toBe(false)
    expect(runtimeEnvironmentHasSshAccess(environments, 'missing')).toBe(false)
    expect(runtimeEnvironmentHasSshAccess(environments, null)).toBe(false)
  })
})
