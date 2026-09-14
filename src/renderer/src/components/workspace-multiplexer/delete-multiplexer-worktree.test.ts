import { beforeEach, expect, it, vi } from 'vitest'
import { deleteMultiplexerWorktree } from './delete-multiplexer-worktree'
import { normalizeWorkspaceMultiplexerState } from '../../../../shared/workspace-multiplexer-types'

const mocks = vi.hoisted(() => ({
  getState: vi.fn(),
  lookup: vi.fn(),
  remove: vi.fn(),
  save: vi.fn()
}))
vi.mock('@/store', () => ({ useAppStore: { getState: mocks.getState } }))
vi.mock('@/store/selectors', () => ({ getWorktreeOnHostFromState: mocks.lookup }))
vi.mock('@/components/sidebar/delete-worktree-flow', () => ({ runWorktreeDelete: mocks.remove }))
const slot = {
  id: 'slot',
  worktreeId: 'worktree',
  executionHostId: 'ssh:dev' as const,
  groupId: null,
  activeTerminalTabId: null
}
beforeEach(() => vi.clearAllMocks())

it('requires host-bound confirmation and removes only successfully deleted host slots from every saved layout', () => {
  const layout = normalizeWorkspaceMultiplexerState({
    slots: [slot, { ...slot, id: 'local-slot', executionHostId: 'local' }]
  })
  const state = {
    workspaceMultiplexer: {
      ...layout,
      activeLayoutId: 'one',
      savedLayouts: [
        { id: 'one', name: 'One', layout },
        { id: 'two', name: 'Two', layout }
      ]
    },
    setWorkspaceMultiplexer: mocks.save
  }
  mocks.getState.mockReturnValue(state)
  mocks.lookup.mockReturnValue({
    id: 'worktree',
    instanceId: 'instance',
    hostId: 'ssh:dev',
    isMainWorktree: false
  })
  deleteMultiplexerWorktree(slot)
  expect(mocks.lookup).toHaveBeenCalledWith(state, 'worktree', 'ssh:dev')
  expect(mocks.remove).toHaveBeenCalledWith(
    'worktree',
    expect.objectContaining({
      expectedHostId: 'ssh:dev',
      expectedInstanceId: 'instance',
      forceConfirm: true
    })
  )
  expect(mocks.save).not.toHaveBeenCalled()
  mocks.remove.mock.calls[0]![1].onDeleted([{ id: 'worktree', executionHostId: 'ssh:dev' }])
  const saved = mocks.save.mock.calls[0]![0]
  expect(saved.slots.map((item: typeof slot) => item.id)).toEqual(['local-slot'])
  expect(
    saved.savedLayouts.map((item: { layout: typeof layout }) => item.layout.slots.map((s) => s.id))
  ).toEqual([['local-slot'], ['local-slot']])
})

it('does not delete missing or primary worktrees', () => {
  mocks.lookup.mockReturnValue(undefined)
  deleteMultiplexerWorktree(slot)
  mocks.lookup.mockReturnValue({ isMainWorktree: true })
  deleteMultiplexerWorktree(slot)
  expect(mocks.remove).not.toHaveBeenCalled()
})

it.each(['slot', 'b', 'c'])(
  'preserves surviving split order and ratios when deleting pane %s',
  (deletedId) => {
    const leaf = (groupId: string) => ({ type: 'leaf' as const, groupId })
    const nested = {
      type: 'split' as const,
      direction: 'vertical' as const,
      ratio: 0.3,
      first: leaf('c'),
      second: leaf('b')
    }
    const tree = {
      type: 'split' as const,
      direction: 'horizontal' as const,
      ratio: 0.65,
      first: leaf('slot'),
      second: nested
    }
    const layout = normalizeWorkspaceMultiplexerState({
      slots: ['slot', 'b', 'c'].map((id) => ({ ...slot, id, worktreeId: id })),
      panes: ['slot', 'b', 'c'].map((id) => ({ id, activeSlotId: id, slotOrder: [id] })),
      layout: tree
    })
    mocks.getState.mockReturnValue({
      workspaceMultiplexer: {
        ...layout,
        activeLayoutId: 'one',
        savedLayouts: [
          { id: 'one', name: 'One', layout },
          { id: 'two', name: 'Two', layout }
        ]
      },
      setWorkspaceMultiplexer: mocks.save
    })
    mocks.lookup.mockReturnValue({ id: deletedId, instanceId: 'instance', isMainWorktree: false })
    deleteMultiplexerWorktree(layout.slots.find((candidate) => candidate.id === deletedId)!)
    mocks.remove.mock.calls[0]![1].onDeleted([{ id: deletedId, executionHostId: 'ssh:dev' }])
    const saved = normalizeWorkspaceMultiplexerState(mocks.save.mock.calls[0]![0])
    const expected =
      deletedId === 'slot'
        ? nested
        : {
            ...tree,
            second: leaf(deletedId === 'b' ? 'c' : 'b')
          }
    expect(saved.layout).toEqual(expected)
    expect(saved.savedLayouts!.map((item) => item.layout.layout)).toEqual([expected, expected])
  }
)
