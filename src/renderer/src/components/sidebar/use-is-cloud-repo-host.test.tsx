// @vitest-environment happy-dom

import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => {
  const state: { runtimeEnvironments: { id: string; name: string; source: string }[] } = {
    runtimeEnvironments: []
  }
  return state
})

vi.mock('@/store/index', () => ({
  useAppStore: <T,>(selector: (state: typeof store) => T): T => selector(store)
}))
vi.mock('@/lib/orca-cloud/use-cloud-recovery-context', () => ({
  useCloudRecoveryContext: () => null
}))

import { useIsCloudRepoHost } from './use-setup-script-asleep-cloud'

describe('the setup-script card skips a project copy on an Orca Cloud sandbox (N-28)', () => {
  afterEach(() => {
    cleanup()
    store.runtimeEnvironments = []
  })

  it('is true for a repo on an Orca Cloud runtime, even with no workspace selected', () => {
    store.runtimeEnvironments = [
      { id: 'env-cloud', name: 'Hello-World sandbox a1b2c3d4', source: 'ephemeral-vm' }
    ]
    const { result } = renderHook(() =>
      useIsCloudRepoHost({ connectionId: null, executionHostId: 'runtime:env-cloud' })
    )
    expect(result.current).toBe(true)
  })

  it('is false for a local repo, a saved server, or no repo', () => {
    store.runtimeEnvironments = [{ id: 'env-server', name: 'build box', source: 'paired' }]
    expect(
      renderHook(() => useIsCloudRepoHost({ connectionId: null, executionHostId: null })).result
        .current
    ).toBe(false)
    expect(
      renderHook(() =>
        useIsCloudRepoHost({ connectionId: null, executionHostId: 'runtime:env-server' })
      ).result.current
    ).toBe(false)
    expect(renderHook(() => useIsCloudRepoHost(null)).result.current).toBe(false)
  })
})
