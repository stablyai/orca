import { describe, expect, it } from 'vitest'
import {
  CREATE_WORKTREE_ITEM_ID,
  createWorktreePaletteRequestGuard,
  getNextWorktreePaletteSelection,
  getWorktreePaletteCreateActionState
} from './worktree-palette-create-action'

describe('worktree-palette-create-action', () => {
  it('shows create for typed queries with workspace matches but selects the first real row', () => {
    const state = getWorktreePaletteCreateActionState({
      canCreateWorktree: true,
      query: 'feature',
      selectableItemIds: ['worktree:one']
    })

    expect(state).toEqual({
      createWorktreeName: 'feature',
      showCreateAction: true,
      shouldDefaultToCreate: false
    })
    expect(
      getNextWorktreePaletteSelection({
        currentSelectedItemId: '',
        queryChanged: true,
        selectableItemIds: ['worktree:one'],
        showCreateAction: state.showCreateAction
      })
    ).toBe('worktree:one')
  })

  it('shows create for typed queries with browser-only matches but selects the browser row', () => {
    const state = getWorktreePaletteCreateActionState({
      canCreateWorktree: true,
      query: 'localhost',
      selectableItemIds: ['browser-page:one']
    })

    expect(state.showCreateAction).toBe(true)
    expect(state.shouldDefaultToCreate).toBe(false)
    expect(
      getNextWorktreePaletteSelection({
        currentSelectedItemId: '',
        queryChanged: true,
        selectableItemIds: ['browser-page:one'],
        showCreateAction: state.showCreateAction
      })
    ).toBe('browser-page:one')
  })

  it('defaults to create for typed queries with no real matches', () => {
    const state = getWorktreePaletteCreateActionState({
      canCreateWorktree: true,
      query: 'new-workspace',
      selectableItemIds: []
    })

    expect(state.showCreateAction).toBe(true)
    expect(state.shouldDefaultToCreate).toBe(true)
    expect(
      getNextWorktreePaletteSelection({
        currentSelectedItemId: '',
        queryChanged: true,
        selectableItemIds: [],
        showCreateAction: state.showCreateAction
      })
    ).toBe(CREATE_WORKTREE_ITEM_ID)
  })

  it('moves selection back to the first real row when the query changes after manual create selection', () => {
    expect(
      getNextWorktreePaletteSelection({
        currentSelectedItemId: CREATE_WORKTREE_ITEM_ID,
        queryChanged: true,
        selectableItemIds: ['worktree:match'],
        showCreateAction: true
      })
    ).toBe('worktree:match')
  })

  it('preserves manual create selection during non-query churn while create remains visible', () => {
    expect(
      getNextWorktreePaletteSelection({
        currentSelectedItemId: CREATE_WORKTREE_ITEM_ID,
        queryChanged: false,
        selectableItemIds: ['worktree:match'],
        showCreateAction: true
      })
    ).toBe(CREATE_WORKTREE_ITEM_ID)
  })

  it('hides create when no git repos are available', () => {
    expect(
      getWorktreePaletteCreateActionState({
        canCreateWorktree: false,
        query: 'new-workspace',
        selectableItemIds: []
      }).showCreateAction
    ).toBe(false)
  })

  it('hides create for an empty query', () => {
    expect(
      getWorktreePaletteCreateActionState({
        canCreateWorktree: true,
        query: '   ',
        selectableItemIds: []
      }).showCreateAction
    ).toBe(false)
  })

  it('falls back deterministically when the selected row disappears', () => {
    expect(
      getNextWorktreePaletteSelection({
        currentSelectedItemId: 'worktree:deleted',
        queryChanged: false,
        selectableItemIds: ['browser-page:first', 'worktree:second'],
        showCreateAction: true
      })
    ).toBe('browser-page:first')
  })

  it('invalidates stale async create lookups', () => {
    const guard = createWorktreePaletteRequestGuard()
    const first = guard.start()

    expect(guard.isCurrent(first)).toBe(true)
    guard.invalidate()
    expect(guard.isCurrent(first)).toBe(false)

    const second = guard.start()
    expect(guard.isCurrent(first)).toBe(false)
    expect(guard.isCurrent(second)).toBe(true)
  })
})
