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

const bridge = {
  localWorkspaces: vi.fn(async () => [{ worktreeId: 'w', sandboxId: 'sbx' }]),
  environmentBindings: vi.fn(async () => ({})),
  get: vi.fn(async () => ({ ok: true, value: { id: 'sbx', visibility: 'private' } }))
}

beforeEach(() => {
  resetCloudWorkspaceRecordsForTests()
  vi.clearAllMocks()
  Object.assign(window, { api: { cloudWorkspaces: bridge } })
})
afterEach(() => {
  Object.assign(window, { api: undefined })
})

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

describe('useCloudWorkspaceRecord', () => {
  it('a menu opened after row hover has the record on its first render', async () => {
    prefetchCloudWorkspaceRecord('w', null)
    await settle()
    const { result } = renderHook(() => useCloudWorkspaceRecord('w', null))
    expect(result.current.loaded).toBe(true)
    expect(result.current.workspace?.id).toBe('sbx')
  })

  it('says not loaded until the first answer, then updates in place', async () => {
    const { result } = renderHook(() => useCloudWorkspaceRecord('w', null))
    expect(result.current.loaded).toBe(false)
    await settle()
    expect(result.current.loaded).toBe(true)
    expect(result.current.workspace?.id).toBe('sbx')
  })

  it('hovering again while fresh asks nothing; a stale record is refreshed', async () => {
    prefetchCloudWorkspaceRecord('w', null, 1_000)
    prefetchCloudWorkspaceRecord('w', null, 1_000)
    await settle()
    expect(bridge.get).toHaveBeenCalledOnce()
    prefetchCloudWorkspaceRecord('w', null, Date.now() + 1)
    await settle()
    expect(bridge.get).toHaveBeenCalledOnce()
    prefetchCloudWorkspaceRecord('w', null, Date.now() + RECORD_FRESH_MS)
    await settle()
    expect(bridge.get).toHaveBeenCalledTimes(2)
  })
})
