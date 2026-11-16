// @vitest-environment happy-dom
// Menu rows that need the team's record are there on the menu's first paint: the record is kept
// per row and fetched on row hover, not first asked for when the menu opens.
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  prefetchCloudWorkspaceRecord,
  RECORD_FRESH_MS,
  resetCloudWorkspaceRecordsForTests,
  useCloudWorkspaceRecord
} from './use-cloud-workspace-record'

const T0 = 1_700_000_000_000

const bridge = {
  localWorkspaces: vi.fn(async () => [{ worktreeId: 'w', sandboxId: 'sbx' }]),
  environmentBindings: vi.fn(async () => ({})),
  get: vi.fn(async () => ({ ok: true, value: { id: 'sbx', visibility: 'private' } }))
}

beforeEach(() => {
  vi.useFakeTimers({ now: T0, toFake: ['Date'] })
  resetCloudWorkspaceRecordsForTests()
  vi.clearAllMocks()
  Object.assign(window, { api: { cloudWorkspaces: bridge } })
})
afterEach(() => {
  vi.useRealTimers()
  Object.assign(window, { api: undefined })
})

describe('useCloudWorkspaceRecord', () => {
  it('a menu opened after row hover has the record on its first render', async () => {
    await prefetchCloudWorkspaceRecord('w', null)
    const { result } = renderHook(() => useCloudWorkspaceRecord('w', null))
    expect(result.current.loaded).toBe(true)
    expect(result.current.workspace?.id).toBe('sbx')
  })

  it('says not loaded until the first answer, then updates in place', async () => {
    const { result } = renderHook(() => useCloudWorkspaceRecord('w', null))
    expect(result.current.loaded).toBe(false)
    await act(() => prefetchCloudWorkspaceRecord('w', null))
    expect(result.current.loaded).toBe(true)
    expect(result.current.workspace?.id).toBe('sbx')
  })

  it('hovering again while fresh asks nothing; a stale record is refreshed', async () => {
    await Promise.all([
      prefetchCloudWorkspaceRecord('w', null, T0),
      prefetchCloudWorkspaceRecord('w', null, T0)
    ])
    expect(bridge.get).toHaveBeenCalledOnce()
    await prefetchCloudWorkspaceRecord('w', null, T0 + 1)
    expect(bridge.get).toHaveBeenCalledOnce()
    await prefetchCloudWorkspaceRecord('w', null, T0 + RECORD_FRESH_MS)
    expect(bridge.get).toHaveBeenCalledTimes(2)
  })
})
