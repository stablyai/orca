import { describe, expect, it } from 'vitest'
import {
  CREATE_WORKTREE_ITEM_ID,
  WORKTREE_PALETTE_SELECTION_MOVE_KEYS,
  createWorktreePaletteRequestGuard,
  getNextWorktreePaletteSelection,
  getWorktreePaletteSelectionItemIds,
  getWorktreePaletteCreateActionState,
  isWorktreePaletteCreateActivationAllowed
} from './worktree-palette-create-action'
import { WORKTREE_PALETTE_QUERY_MAX_BYTES } from './worktree-palette-query-bounds'

describe('worktree-palette-create-action', () => {
  it('shows create for typed queries with workspace matches but selects the first workspace row', () => {
    const state = getWorktreePaletteCreateActionState({
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

  it('skips create for free text even when it is listed before every other row', () => {
    const state = getWorktreePaletteCreateActionState({
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
    ).toBe('settings:ai-provider-accounts')
  })

  it('selects create ahead of other rows only for a recognized task URL', () => {
    const selectableItemIds = [CREATE_WORKTREE_ITEM_ID, 'browser-page:one']

    expect(
      getNextWorktreePaletteSelection({
        currentSelectedItemId: '',
        queryChanged: true,
        selectableItemIds,
        showCreateAction: true
      })
    ).toBe('browser-page:one')
    expect(
      getNextWorktreePaletteSelection({
        currentSelectedItemId: '',
        queryChanged: true,
        selectableItemIds,
        showCreateAction: true,
        autoSelectCreateAction: true
      })
    ).toBe(CREATE_WORKTREE_ITEM_ID)
  })

  it('leaves Enter unarmed for typed queries with no real matches', () => {
    const state = getWorktreePaletteCreateActionState({
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
    ).toBe('')
    expect(
      getNextWorktreePaletteSelection({
        currentSelectedItemId: '',
        queryChanged: true,
        selectableItemIds: [],
        showCreateAction: state.showCreateAction,
        autoSelectCreateAction: true
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

  it('offers create with no projects, since the composer adds the first one inline', () => {
    expect(
      getWorktreePaletteCreateActionState({
        query: 'new-workspace'
      })
    ).toEqual({ createWorktreeName: 'new-workspace', showCreateAction: true })
  })

  it('hides create for an empty query', () => {
    expect(
      getWorktreePaletteCreateActionState({
        query: '   '
      }).showCreateAction
    ).toBe(false)
  })

  it('hides create for oversized pasted queries without echoing the payload', () => {
    const oversizedQuery = 'secret-create-worktree-name'.repeat(WORKTREE_PALETTE_QUERY_MAX_BYTES)

    expect(
      getWorktreePaletteCreateActionState({
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

  it('names the rendered render key so a duplicate row is reachable by keyboard', () => {
    // Why: rows render under de-duplicated keys, and cmdk selects by that rendered value.
    // Naming the bare id here left the duplicate absent from the allow-list, so arrowing
    // onto it failed the `includes` check and snapped the highlight back to the top.
    expect(
      getWorktreePaletteSelectionItemIds(
        [
          { id: '__header_worktrees__', type: 'section-header' },
          { id: 'worktree:shared', type: 'worktree' },
          { id: 'worktree:shared', type: 'worktree' }
        ],
        ['__header_worktrees__', 'worktree:shared', 'worktree:shared#dup1']
      )
    ).toEqual(['worktree:shared', 'worktree:shared#dup1'])
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

  it('leaves create unarmed for free text until the user moves the selection', () => {
    // Why: cmdk auto-selects the first row once the controlled value empties, so
    // with Create alone on screen Enter would fire without any user gesture.
    expect(
      isWorktreePaletteCreateActivationAllowed({
        hasTaskUrlIntent: false,
        selectionMovedByUser: false
      })
    ).toBe(false)
    expect(
      isWorktreePaletteCreateActivationAllowed({
        hasTaskUrlIntent: false,
        selectionMovedByUser: true
      })
    ).toBe(true)
    expect(
      isWorktreePaletteCreateActivationAllowed({
        hasTaskUrlIntent: true,
        selectionMovedByUser: false
      })
    ).toBe(true)
  })

  it('counts only navigation keys as a user selection move', () => {
    expect([...WORKTREE_PALETTE_SELECTION_MOVE_KEYS].sort()).toEqual([
      'ArrowDown',
      'ArrowUp',
      'End',
      'Home',
      'PageDown',
      'PageUp'
    ])
    // Enter is the activation itself, so it must never count as the gesture that arms it.
    expect(WORKTREE_PALETTE_SELECTION_MOVE_KEYS.has('Enter')).toBe(false)
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
