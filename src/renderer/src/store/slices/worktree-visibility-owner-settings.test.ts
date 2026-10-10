import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearRuntimeCompatibilityCacheForTests,
  markRuntimeEnvironmentCompatible
} from '@/runtime/runtime-rpc-client'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import {
  hydrateOwnerWorktreeVisibilityDefaults,
  readRuntimeWorktreeVisibilityDefaults
} from './worktree-visibility-owner-settings'

const runtimeCall = vi.fn()

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  markRuntimeEnvironmentCompatible('env-1')
  runtimeCall.mockReset()
  vi.stubGlobal('window', { api: { runtimeEnvironments: { call: runtimeCall } } })
})

describe('runtime worktree visibility defaults', () => {
  it('reads defaults from the selected runtime owner', async () => {
    runtimeCall.mockResolvedValue({
      ok: true,
      result: { settings: { worktreeVisibilityDefaults: { external: 'show' } } },
      _meta: { runtimeId: 'runtime-1' }
    })

    await expect(readRuntimeWorktreeVisibilityDefaults('env-1')).resolves.toEqual({
      external: 'show'
    })
    expect(runtimeCall).toHaveBeenCalledWith(
      expect.objectContaining({ selector: 'env-1', method: 'settings.get' })
    )
  })

  it('uses compatibility fallback semantics when the host omits the field', async () => {
    runtimeCall.mockResolvedValue({
      ok: true,
      result: { settings: {} },
      _meta: { runtimeId: 'runtime-1' }
    })

    await expect(readRuntimeWorktreeVisibilityDefaults('env-1')).resolves.toBeNull()
  })

  it('preserves cached support state when the host is temporarily unavailable', async () => {
    runtimeCall.mockRejectedValue(new Error('offline'))

    const hydrated = await hydrateOwnerWorktreeVisibilityDefaults(
      {
        activeRuntimeEnvironmentId: 'env-1',
        worktreeVisibilityDefaults: { external: 'hide' }
      } as GlobalSettings,
      { 'runtime:env-1': { external: 'show' } }
    )

    expect(hydrated.settings.worktreeVisibilityDefaults).toEqual({ external: 'show' })
    expect(hydrated.supportedRuntimeEnvironmentId).toBe('env-1')
    expect(hydrated.sourceDefaultsSupportedRuntimeEnvironmentId).toBeNull()
  })

  it('preserves local defaults while projecting the focused runtime owner', async () => {
    runtimeCall.mockResolvedValue({
      ok: true,
      result: { settings: { worktreeVisibilityDefaults: { external: 'show' } } },
      _meta: { runtimeId: 'runtime-1' }
    })

    const hydrated = await hydrateOwnerWorktreeVisibilityDefaults(
      {
        activeRuntimeEnvironmentId: 'env-1',
        worktreeVisibilityDefaults: { external: 'hide' }
      } as GlobalSettings,
      {}
    )

    expect(hydrated.defaultsByHost[LOCAL_EXECUTION_HOST_ID]).toEqual({ external: 'hide' })
    expect(hydrated.defaultsByHost['runtime:env-1']).toEqual({ external: 'show' })
  })
})
