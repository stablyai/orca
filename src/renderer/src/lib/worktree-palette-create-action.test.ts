import { describe, expect, it } from 'vitest'
import {
  CREATE_WORKTREE_ITEM_ID,
  createWorktreePaletteRequestGuard,
  getNextWorktreePaletteSelection,
  getWorktreePaletteSelectionItemIds,
  getWorktreePaletteCreateActionState
} from './worktree-palette-create-action'
import { WORKTREE_PALETTE_QUERY_MAX_BYTES } from './worktree-palette-query-bounds'

describe('worktree-palette-create-action', () => {
  it('shows create for typed queries with workspace matches but selects the first workspace row', () => {
    const state = getWorktreePaletteCreateActionState({
      canCreateWorktree: true,
      query: 'feature'
    })

    expect(state).toEqual({
      createWorktreeName: 'feature',
      showCreateAction: true
    })
    expect(
      getNextWorktreePaletteSelection({
        currentSelectedItemId: '',
        queryChanged: true,
        selectableItemIds: ['worktree:one', CREATE_WORKTREE_ITEM_ID, 'settings:provider'],
        showCreateAction: state.showCreateAction
      })
    ).toBe('worktree:one')
  })

  it('selects create when it appears before actions, settings, and browser rows', () => {
    const state = getWorktreePaletteCreateActionState({
      canCreateWorktree: true,
      query: 'opencode-issue'
    })

    expect(state.showCreateAction).toBe(true)
    expect(
      getNextWorktreePaletteSelection({
        currentSelectedItemId: '',
        queryChanged: true,
        selectableItemIds: [
          CREATE_WORKTREE_ITEM_ID,
          'settings:ai-provider-accounts',
          'quick-action:new-terminal',
          'browser-page:one'
        ],
        showCreateAction: state.showCreateAction
      })
    ).toBe(CREATE_WORKTREE_ITEM_ID)
  })

  it('selects create when it appears before a browser-only match', () => {
    expect(
      getNextWorktreePaletteSelection({
        currentSelectedItemId: '',
        queryChanged: true,
        selectableItemIds: [CREATE_WORKTREE_ITEM_ID, 'browser-page:one'],
        showCreateAction: true
      })
    ).toBe(CREATE_WORKTREE_ITEM_ID)
  })

  it('defaults to create for typed queries with no real matches', () => {
    const state = getWorktreePaletteCreateActionState({
      canCreateWorktree: true,
      query: 'new-workspace'
    })

    expect(state.showCreateAction).toBe(true)
    expect(
      getNextWorktreePaletteSelection({
        currentSelectedItemId: '',
        queryChanged: true,
        selectableItemIds: [],
        showCreateAction: state.showCreateAction
      })
    ).toBe(CREATE_WORKTREE_ITEM_ID)
  })

  it('returns empty selection when no create action or rows are available', () => {
    expect(
      getNextWorktreePaletteSelection({
        currentSelectedItemId: '',
        queryChanged: true,
        selectableItemIds: [],
        showCreateAction: false
      })
    ).toBe('')
  })

  it('falls back to the first row when render-time selection state is empty', () => {
    expect(
      getNextWorktreePaletteSelection({
        currentSelectedItemId: '',
        queryChanged: false,
        selectableItemIds: ['worktree:first', 'browser-page:second'],
        showCreateAction: true
      })
    ).toBe('worktree:first')
  })

  it('does not keep create selected after the create row disappears', () => {
    expect(
      getNextWorktreePaletteSelection({
        currentSelectedItemId: CREATE_WORKTREE_ITEM_ID,
        queryChanged: false,
        selectableItemIds: ['settings:ai-provider-accounts'],
        showCreateAction: false
      })
    ).toBe('settings:ai-provider-accounts')
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

  it('shows create even when no project is available so the composer can guide setup', () => {
    expect(
      getWorktreePaletteCreateActionState({
        canCreateWorktree: false,
        query: 'new-workspace'
      }).showCreateAction
    ).toBe(true)
  })

  it('hides create for an empty query', () => {
    expect(
      getWorktreePaletteCreateActionState({
        canCreateWorktree: true,
        query: '   '
      }).showCreateAction
    ).toBe(false)
  })

  it('hides create for oversized pasted queries without echoing the payload', () => {
    const oversizedQuery = 'secret-create-worktree-name'.repeat(WORKTREE_PALETTE_QUERY_MAX_BYTES)

    expect(
      getWorktreePaletteCreateActionState({
        canCreateWorktree: true,
        query: oversizedQuery
      })
    ).toEqual({
      createWorktreeName: '',
      showCreateAction: false
    })
  })

  it('derives selection ids from rendered entries while skipping headers and hints', () => {
    expect(
      getWorktreePaletteSelectionItemIds([
        { id: '__header_worktrees__', type: 'section-header' },
        { id: 'worktree:one', type: 'worktree' },
        { id: CREATE_WORKTREE_ITEM_ID, type: 'create-worktree' },
        { id: '__hint_worktree_cap__', type: 'hint' },
        { id: '__header_actions_settings__', type: 'section-header' },
        { id: 'settings:ai-provider-accounts', type: 'settings' },
        { id: 'quick-action:new-terminal', type: 'quick-action' },
        { id: '__header_browser__', type: 'section-header' },
        { id: 'browser-page:one', type: 'browser-page' }
      ])
    ).toEqual([
      'worktree:one',
      CREATE_WORKTREE_ITEM_ID,
      'settings:ai-provider-accounts',
      'quick-action:new-terminal',
      'browser-page:one'
    ])
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
