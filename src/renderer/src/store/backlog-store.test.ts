import { describe, expect, it } from 'vitest'
import { useBacklogStore } from './backlog-store'

describe('backlog-store', () => {
  it('initializes with default state', () => {
    const state = useBacklogStore.getState()
    expect(state.isBacklogOpen).toBe(false)
    expect(state.viewMode).toBe('checklist')
    expect(state.categoryFilter).toBe('all')
  })

  it('toggles backlog open and view modes', () => {
    const { setBacklogOpen, setViewMode } = useBacklogStore.getState()
    setBacklogOpen(true)
    expect(useBacklogStore.getState().isBacklogOpen).toBe(true)

    setViewMode('kanban')
    expect(useBacklogStore.getState().viewMode).toBe('kanban')

    setViewMode('checklist')
    expect(useBacklogStore.getState().viewMode).toBe('checklist')
  })

  it('adds custom backlog item and toggles completion', () => {
    const { addCustomItem, toggleItemStatus } = useBacklogStore.getState()
    addCustomItem('Implement E2E test for multi-agent')

    const state = useBacklogStore.getState()
    expect(state.customItems.length).toBeGreaterThan(0)
    const item = state.customItems[0]
    expect(item.title).toBe('Implement E2E test for multi-agent')
    expect(item.status).toBe('todo')

    toggleItemStatus(item.id)
    expect(useBacklogStore.getState().customItems[0].status).toBe('completed')

    toggleItemStatus(item.id)
    expect(useBacklogStore.getState().customItems[0].status).toBe('todo')
  })

  it('assigns agent to backlog item and updates status to in_progress', () => {
    const { addCustomItem, assignAgentToItem } = useBacklogStore.getState()
    addCustomItem('Review PR #110')
    const item = useBacklogStore.getState().customItems[0]

    assignAgentToItem(item.id, { index: 2, label: '@2 exec-cursor' })
    const updated = useBacklogStore.getState().customItems[0]
    expect(updated.assignedAgent).toEqual({ index: 2, label: '@2 exec-cursor' })
    expect(updated.status).toBe('in_progress')

    assignAgentToItem(item.id, undefined)
    expect(useBacklogStore.getState().customItems[0].assignedAgent).toBeUndefined()
  })
})
