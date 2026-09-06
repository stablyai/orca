import { describe, expect, it } from 'vitest'
import { getActiveRuntimeTarget } from '@/runtime/runtime-client-target'
import {
  resolveComposerDropUploadSettings,
  shouldUploadComposerDropPaths
} from './composer-drop-upload-route'

describe('shouldUploadComposerDropPaths', () => {
  it('uploads when a runtime environment is selected without SSH', () => {
    expect(
      shouldUploadComposerDropPaths({
        settings: { activeRuntimeEnvironmentId: 'env-1' },
        connectionId: null
      })
    ).toBe(true)
  })

  it('uploads when the selected repo execution host is a remote runtime without SSH', () => {
    expect(
      shouldUploadComposerDropPaths({
        settings: { activeRuntimeEnvironmentId: null },
        connectionId: null,
        repo: { id: 'repo-1', connectionId: null, executionHostId: 'runtime:env-1' }
      })
    ).toBe(true)
  })

  it('uploads when the worktree execution host is a remote runtime without SSH', () => {
    expect(
      shouldUploadComposerDropPaths({
        settings: { activeRuntimeEnvironmentId: null },
        connectionId: null,
        executionHostId: 'runtime:env-1'
      })
    ).toBe(true)
  })

  it('keeps local SSH-less drops local even while a runtime is focused', () => {
    expect(
      shouldUploadComposerDropPaths({
        settings: { activeRuntimeEnvironmentId: 'focused-runtime' },
        connectionId: null,
        repo: { id: 'repo-1', connectionId: null, executionHostId: 'local' }
      })
    ).toBe(false)
  })

  it('uploads SSH targets without a runtime environment', () => {
    expect(
      shouldUploadComposerDropPaths({
        settings: { activeRuntimeEnvironmentId: null },
        connectionId: 'ssh-1'
      })
    ).toBe(true)
  })
})

describe('resolveComposerDropUploadSettings', () => {
  it('routes repo-owned remote runtimes so importExternalPathsToRuntime is not skipped', () => {
    const settings = resolveComposerDropUploadSettings({
      settings: { activeRuntimeEnvironmentId: null },
      connectionId: null,
      repo: { id: 'repo-1', connectionId: null, executionHostId: 'runtime:env-1' }
    })

    expect(settings).toEqual({ activeRuntimeEnvironmentId: 'env-1' })
    expect(getActiveRuntimeTarget(settings)).toEqual({
      kind: 'environment',
      environmentId: 'env-1'
    })
  })

  it('keeps explicit local repos on the local host', () => {
    const settings = resolveComposerDropUploadSettings({
      settings: { activeRuntimeEnvironmentId: 'focused-runtime' },
      connectionId: null,
      repo: { id: 'repo-1', connectionId: null, executionHostId: 'local' },
      executionHostId: 'local'
    })

    expect(settings).toEqual({ activeRuntimeEnvironmentId: null })
    expect(getActiveRuntimeTarget(settings)).toEqual({ kind: 'local' })
  })
})
