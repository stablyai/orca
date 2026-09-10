import { describe, expect, it } from 'vitest'
import {
  addWorkspaceMultiplexer,
  selectWorkspaceMultiplexer,
  removeWorkspaceMultiplexer
} from './workspace-multiplexer-collections'
import {
  normalizeWorkspaceMultiplexerState,
  remapWorkspaceMultiplexerWorktreeId
} from './workspace-multiplexer-types'

const original = normalizeWorkspaceMultiplexerState({
  slots: [
    {
      id: 'slot',
      worktreeId: 'old',
      executionHostId: 'ssh:dev',
      groupId: 'group',
      activeTerminalTabId: 'terminal'
    }
  ]
})

describe('saved multiplexer layouts', () => {
  it('preserves the original, isolates edits, restores selection and survives serialization', () => {
    let state = normalizeWorkspaceMultiplexerState(addWorkspaceMultiplexer(original, 'second'))
    expect(state.slots).toEqual([])
    state = normalizeWorkspaceMultiplexerState({
      ...state,
      ...normalizeWorkspaceMultiplexerState({
        slots: [
          { id: 'folder-slot', worktreeId: 'folder:test', groupId: null, activeTerminalTabId: null }
        ]
      })
    })
    state = normalizeWorkspaceMultiplexerState(JSON.parse(JSON.stringify(state)))
    expect(state.activeLayoutId).toBe('second')
    expect(state.slots[0]?.worktreeId).toBe('folder:test')
    state = normalizeWorkspaceMultiplexerState(selectWorkspaceMultiplexer(state, 'default'))
    expect(state.slots).toEqual(original.slots)
    expect(
      state.savedLayouts?.find((item) => item.id === 'second')?.layout.slots[0]?.worktreeId
    ).toBe('folder:test')
    state = normalizeWorkspaceMultiplexerState(removeWorkspaceMultiplexer(state, 'default'))
    expect(state.activeLayoutId).toBe('second')
    expect(state.slots[0]?.worktreeId).toBe('folder:test')
    expect(
      normalizeWorkspaceMultiplexerState(removeWorkspaceMultiplexer(state, 'second')).slots
    ).toEqual([])
  })

  it('migrates inactive SSH workspaces only on their owning host', () => {
    const state = normalizeWorkspaceMultiplexerState(addWorkspaceMultiplexer(original, 'second'))
    expect(remapWorkspaceMultiplexerWorktreeId(state, 'old', 'new', 'local')).toBe(state)
    const renamed = remapWorkspaceMultiplexerWorktreeId(state, 'old', 'new', 'ssh:dev')!
    expect(selectWorkspaceMultiplexer(renamed, 'default').slots[0]?.worktreeId).toBe('new')
  })

  it('rejects duplicate ids, bounds malformed saved layouts, and ignores unknown selections', () => {
    const state = normalizeWorkspaceMultiplexerState({
      ...original,
      activeLayoutId: 'missing',
      savedLayouts: [null, { id: 'a', layout: original }, { id: 'a', layout: original }]
    })
    expect(state.savedLayouts).toHaveLength(1)
    expect(selectWorkspaceMultiplexer(state, 'missing')).toBe(state)
    expect(removeWorkspaceMultiplexer(state, 'missing')).toBe(state)
    expect(addWorkspaceMultiplexer(state, 'a')).toBe(state)
    expect(
      normalizeWorkspaceMultiplexerState({
        ...original,
        savedLayouts: Array.from({ length: 30 }, (_, i) => ({ id: String(i), layout: original }))
      }).savedLayouts
    ).toHaveLength(24)
  })
})
