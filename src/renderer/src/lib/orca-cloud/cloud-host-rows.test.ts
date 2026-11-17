// @vitest-environment happy-dom
// A cloud workspace created from a GitHub-only repo is paired from birth: its row sits on a
// "<repo> (cloud)" server on the sandbox's own checkout ("master · primary"). The runtime catalog's
// paired mark alone must make it a cloud row (no "primary" badge, "Delete workspace…", Sleep reaches
// the sandbox), before anything has loaded the pairing bindings.
import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

type CatalogEntry = {
  id: string
  name: string
  source?: 'manual' | 'ephemeral-vm'
  orcaCloudPaired?: true
}
const state = vi.hoisted(() => {
  const value: { runtimeEnvironments: CatalogEntry[] } = { runtimeEnvironments: [] }
  return value
})
vi.mock('@/store', () => ({
  useAppStore: Object.assign((selector: (value: typeof state) => unknown) => selector(state), {
    getState: () => state
  })
}))

import {
  isCloudPrimaryRowNow,
  useIsCloudHostRow,
  useIsCloudPrimaryRow,
  useIsPairedCloudPrimaryRow
} from './cloud-host-rows'

const fromGitHub = {
  id: 'push-test::/workspace/orca-sandbox-push-test',
  hostId: 'runtime:env-gh',
  isMainWorktree: true
}

afterEach(() => {
  state.runtimeEnvironments = []
})

describe('a paired-from-birth cloud row (GitHub-only create)', () => {
  it('is a cloud primary row from the catalog mark alone: no primary badge, Delete workspace…', () => {
    state.runtimeEnvironments = [
      { id: 'env-gh', name: 'orca-sandbox-push-test (cloud)', orcaCloudPaired: true }
    ]
    expect(renderHook(() => useIsCloudHostRow(fromGitHub)).result.current).toBe(true)
    expect(renderHook(() => useIsCloudPrimaryRow(fromGitHub)).result.current).toBe(true)
    expect(renderHook(() => useIsPairedCloudPrimaryRow(fromGitHub)).result.current).toBe(true)
    expect(isCloudPrimaryRowNow(fromGitHub)).toBe(true)
  })

  it('the same row on an ordinary paired server is not a cloud row (upstream rules apply)', () => {
    state.runtimeEnvironments = [{ id: 'env-gh', name: 'build box (cloud)', source: 'manual' }]
    expect(renderHook(() => useIsCloudHostRow(fromGitHub)).result.current).toBe(false)
    expect(isCloudPrimaryRowNow(fromGitHub)).toBe(false)
  })

  it('a local primary checkout is never a cloud row', () => {
    const local = { id: 'repo::/path', hostId: 'local', isMainWorktree: true }
    expect(renderHook(() => useIsCloudHostRow(local)).result.current).toBe(false)
    expect(isCloudPrimaryRowNow(local)).toBe(false)
  })
})
