import { describe, expect, it } from 'vitest'
import { shouldUploadRemoteEditorFileDrop } from './useGlobalFileDrop'

describe('shouldUploadRemoteEditorFileDrop', () => {
  it('does not upload editor drops for local workspaces', () => {
    expect(shouldUploadRemoteEditorFileDrop({ activeRuntimeEnvironmentId: null }, null)).toBe(false)
  })

  it('uploads editor drops while a runtime environment is active', () => {
    expect(shouldUploadRemoteEditorFileDrop({ activeRuntimeEnvironmentId: 'env-1' }, null)).toBe(
      true
    )
  })

  it('uploads editor drops for SSH workspaces', () => {
    expect(shouldUploadRemoteEditorFileDrop({ activeRuntimeEnvironmentId: null }, 'ssh-1')).toBe(
      true
    )
  })
})
