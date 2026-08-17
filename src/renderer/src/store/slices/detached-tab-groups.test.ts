import { describe, expect, it } from 'vitest'
import { createTestStore } from './store-test-helpers'

function createTerminalGroup(store: ReturnType<typeof createTestStore>, id: string): string {
  return store.getState().createUnifiedTab('worktree-1', 'terminal', { id }).groupId
}

describe('detached tab groups', () => {
  it('detaches, stays idempotent, and reattaches', () => {
    const store = createTestStore()
    const group1 = createTerminalGroup(store, 'terminal-1')
    const terminal2 = store
      .getState()
      .createUnifiedTabInSplit(
        'worktree-1',
        'terminal',
        { sourceGroupId: group1, splitDirection: 'right' },
        { id: 'terminal-2' }
      )!

    expect(store.getState().detachedGroupIds).toEqual([])

    store.getState().detachTabGroup(group1)
    store.getState().detachTabGroup(group1)
    expect(store.getState().detachedGroupIds).toEqual([group1])

    store.getState().detachTabGroup(terminal2.groupId)
    expect(store.getState().detachedGroupIds).toEqual([group1, terminal2.groupId])

    store.getState().reattachTabGroup(group1)
    expect(store.getState().detachedGroupIds).toEqual([terminal2.groupId])
  })

  it('keeps the same state object when nothing changes', () => {
    const store = createTestStore()
    const groupId = createTerminalGroup(store, 'terminal-1')
    store.getState().detachTabGroup(groupId)
    const before = store.getState().detachedGroupIds

    // Why: a fresh array on a no-op would re-render every pane subscribing to it.
    store.getState().detachTabGroup(groupId)
    store.getState().reattachTabGroup('group-absent')
    expect(store.getState().detachedGroupIds).toBe(before)
  })

  it('rejects nonterminal groups and reattaches before adding nonterminal content', () => {
    const store = createTestStore()
    const terminalGroup = createTerminalGroup(store, 'terminal-1')
    const editor = store
      .getState()
      .createUnifiedTabInSplit(
        'worktree-1',
        'editor',
        { sourceGroupId: terminalGroup, splitDirection: 'right' },
        { id: 'editor-1' }
      )!

    store.getState().detachTabGroup(editor.groupId)
    expect(store.getState().detachedGroupIds).toEqual([])

    store.getState().detachTabGroup(terminalGroup)
    store.getState().createUnifiedTab('worktree-1', 'browser', {
      id: 'browser-1',
      targetGroupId: terminalGroup
    })
    expect(store.getState().detachedGroupIds).toEqual([])
  })

  it('reattaches a destination receiving nonterminal content', () => {
    const store = createTestStore()
    const terminalGroup = createTerminalGroup(store, 'terminal-1')
    const editor = store
      .getState()
      .createUnifiedTabInSplit(
        'worktree-1',
        'editor',
        { sourceGroupId: terminalGroup, splitDirection: 'right' },
        { id: 'editor-1' }
      )!
    store.getState().detachTabGroup(terminalGroup)

    expect(store.getState().moveUnifiedTabToGroup(editor.id, terminalGroup)).toBe(true)
    expect(store.getState().detachedGroupIds).toEqual([])
  })

  it('prunes detached state and bounds when a group disappears', () => {
    const store = createTestStore()
    const firstGroup = createTerminalGroup(store, 'terminal-1')
    const second = store
      .getState()
      .createUnifiedTabInSplit(
        'worktree-1',
        'terminal',
        { sourceGroupId: firstGroup, splitDirection: 'right' },
        { id: 'terminal-2' }
      )!
    store.getState().detachTabGroup(second.groupId)
    store
      .getState()
      .recordAuxWindowBounds(second.groupId, { x: 10, y: 20, width: 900, height: 600 })

    expect(store.getState().moveUnifiedTabToGroup(second.id, firstGroup)).toBe(true)
    expect(store.getState().detachedGroupIds).toEqual([])
    expect(store.getState().auxWindowBoundsByGroupId).toEqual({})

    store
      .getState()
      .recordAuxWindowBounds(second.groupId, { x: 30, y: 40, width: 900, height: 600 })
    expect(store.getState().auxWindowBoundsByGroupId).toEqual({})
  })
})
