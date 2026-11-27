import { beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import type { AppState } from '../../types'
import type { ItsaplanIssue } from '../../../../../shared/itsaplan/itsaplan-types'
import { itsaplanIssueListCacheKey } from './itsaplan-slice-contract'
import { createItsaplanSlice } from './itsaplan'

const listIssues = vi.fn()
const updateIssue = vi.fn()
const disconnect = vi.fn()
const status = vi.fn()

vi.mock('@/runtime/itsaplan/runtime-itsaplan-client', () => ({
  createRuntimeItsaplanClient: () => ({
    listIssues: (...args: unknown[]) => listIssues(...args),
    updateIssue: (...args: unknown[]) => updateIssue(...args),
    disconnect: (...args: unknown[]) => disconnect(...args),
    status: (...args: unknown[]) => status(...args)
  })
}))

function issue(id: number, columnId: number): ItsaplanIssue {
  return {
    id,
    identifier: `E-${id}`,
    sequenceNumber: id,
    projectRef: 'a.E',
    title: `Issue ${id}`,
    description: '',
    priority: null,
    state: { columnId, name: 'Col', stateType: 'unstarted' },
    labels: [],
    assignee: null,
    delegate: null,
    parentId: null,
    url: `https://plan.example.com/issue/${id}`,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z'
  }
}

function createTestStore() {
  return create<AppState>()(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the test store carries only the slice and settings under test.
    (...a) => ({ settings: null, ...createItsaplanSlice(...a) }) as unknown as AppState
  )
}

describe('itsaplan slice', () => {
  beforeEach(() => {
    listIssues.mockReset()
    updateIssue.mockReset()
    disconnect.mockReset().mockResolvedValue(undefined)
    status.mockReset().mockResolvedValue({ connected: true, viewer: null, instance: null })
  })

  it('propagates an updated issue into cached lists', async () => {
    const query = { projectRef: 'a.E', filters: {} }
    listIssues.mockResolvedValue([issue(4, 1), issue(5, 1)])
    updateIssue.mockResolvedValue({ ok: true, issue: issue(5, 9) })
    const store = createTestStore()
    await store.getState().loadItsaplanIssues(query)

    await store.getState().updateItsaplanIssue(5, { columnId: 9 })

    const entry = store.getState().itsaplanIssueLists[itsaplanIssueListCacheKey(query)]
    expect(entry.issues.map((item) => [item.id, item.state.columnId])).toEqual([
      [4, 1],
      [5, 9]
    ])
  })

  it('keeps previous issues and records the error when a reload fails', async () => {
    const query = { projectRef: 'a.E', filters: {} }
    listIssues.mockResolvedValueOnce([issue(4, 1)])
    listIssues.mockRejectedValueOnce(new Error('invalidApiKey: API key invalid, reconnect'))
    const store = createTestStore()
    await store.getState().loadItsaplanIssues(query)

    await store.getState().loadItsaplanIssues(query, { force: true })

    const entry = store.getState().itsaplanIssueLists[itsaplanIssueListCacheKey(query)]
    expect(entry.issues.map((item) => item.id)).toEqual([4])
    expect(entry.error).toBe('invalidApiKey: API key invalid, reconnect')
    expect(entry.loading).toBe(false)
  })

  it('drops a list read that resolves after disconnect', async () => {
    let resolveList!: (issues: ItsaplanIssue[]) => void
    listIssues.mockReturnValue(
      new Promise<ItsaplanIssue[]>((resolve) => {
        resolveList = resolve
      })
    )
    const store = createTestStore()
    const pending = store.getState().loadItsaplanIssues({ projectRef: 'a.E', filters: {} })

    await store.getState().disconnectItsaplan()
    resolveList([issue(4, 1)])
    await pending

    expect(store.getState().itsaplanIssueLists).toEqual({})
  })

  it('drops cached lists when the status is refreshed for another runtime', async () => {
    listIssues.mockResolvedValue([issue(4, 1)])
    const store = createTestStore()
    await store.getState().refreshItsaplanStatus()
    await store.getState().loadItsaplanIssues({ projectRef: 'a.E', filters: {} })

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the slice reads only activeRuntimeEnvironmentId.
    store.setState({ settings: { activeRuntimeEnvironmentId: 'env-b' } } as unknown as AppState)
    await store.getState().refreshItsaplanStatus()

    expect(store.getState().itsaplanIssueLists).toEqual({})
  })
})
