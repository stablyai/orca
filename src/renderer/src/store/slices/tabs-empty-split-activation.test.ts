import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { createTabsSliceMockApi } from './tabs-slice-test-harness'
import { createTestStore } from './store-test-helpers'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))

vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return {
    ...actual,
    detectAgentStatusFromTitle: vi.fn().mockReturnValue(null)
  }
})

createTabsSliceMockApi()

const WT = 'repo1::/tmp/feature'

describe('createEmptySplitGroup', () => {
  let store: ReturnType<typeof createTestStore>

  beforeEach(() => {
    store = createTestStore()
  })

  it('activates the new group by default so terminal splits land in the empty pane', () => {
    const tab = store.getState().createUnifiedTab(WT, 'terminal')
    const sourceGroupId = store.getState().groupsByWorktree[WT][0].id

    const targetGroupId = store.getState().createEmptySplitGroup(WT, sourceGroupId, 'right')

    expect(targetGroupId).toBeTruthy()
    expect(store.getState().activeGroupIdByWorktree[WT]).toBe(targetGroupId)
    expect(
      store.getState().groupsByWorktree[WT].find((group) => group.id === sourceGroupId)
    ).toEqual(expect.objectContaining({ tabOrder: [tab.id] }))
  })

  it('keeps the source group focused when activate is false', () => {
    store.getState().createUnifiedTab(WT, 'editor', { id: 'file-a.ts', label: 'file-a.ts' })
    const sourceGroupId = store.getState().groupsByWorktree[WT][0].id

    const targetGroupId = store.getState().createEmptySplitGroup(WT, sourceGroupId, 'right', {
      activate: false
    })

    expect(targetGroupId).toBeTruthy()
    expect(store.getState().activeGroupIdByWorktree[WT]).toBe(sourceGroupId)
    expect(store.getState().groupsByWorktree[WT].map((group) => group.id)).toEqual([
      sourceGroupId,
      targetGroupId
    ])
  })
})
