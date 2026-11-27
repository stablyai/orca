import { beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import type { AppState } from '../../types'
import type { ItsaplanIssue } from '../../../../../shared/itsaplan/itsaplan-types'
import { itsaplanIssueListCacheKey } from './itsaplan-slice-contract'
import { createItsaplanSlice } from './itsaplan'

const listIssues = vi.fn()
const updateIssue = vi.fn()

vi.mock('@/runtime/itsaplan/runtime-itsaplan-client', () => ({
  createRuntimeItsaplanClient: () => ({
    listIssues: (...args: unknown[]) => listIssues(...args),
    updateIssue: (...args: unknown[]) => updateIssue(...args)
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
    (...a) => ({ settings: null, ...createItsaplanSlice(...a) }) as unknown as AppState
  )
}

describe('itsaplan slice', () => {
  beforeEach(() => {
    listIssues.mockReset()
    updateIssue.mockReset()
  })

  it('uses one cache key regardless of label id order', () => {
    expect(itsaplanIssueListCacheKey({ projectRef: 'a.E', filters: { labelIds: [2, 1] } })).toBe(
      itsaplanIssueListCacheKey({ projectRef: 'a.E', filters: { labelIds: [1, 2] } })
    )
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
})
