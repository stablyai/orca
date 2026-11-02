import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabMove } from '../../../../shared/runtime-types'
import type { dropTabThroughLayoutOwner } from '@/components/tab-group/tab-group-layout-owner-commands'
import { registerSessionTabIpcBridge } from './session-tab-ipc-bridge'

type Move = { worktreeId: string } & RuntimeMobileSessionTabMove

const mocks = vi.hoisted(() => {
  const held: {
    drop: ReturnType<typeof vi.fn<typeof dropTabThroughLayoutOwner>>
    store: {
      reorderUnifiedTabs: ReturnType<typeof vi.fn>
      dropUnifiedTab: ReturnType<typeof vi.fn>
    }
  } = {
    drop: vi.fn<typeof dropTabThroughLayoutOwner>(),
    store: { reorderUnifiedTabs: vi.fn(), dropUnifiedTab: vi.fn() }
  }
  return held
})

vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))
vi.mock('@/components/tab-group/tab-group-layout-owner-commands', () => ({
  dropTabThroughLayoutOwner: mocks.drop
}))
vi.mock('../../store', () => ({ useAppStore: { getState: () => mocks.store } }))

let onMove: (move: Move) => void = () => {}

beforeEach(() => {
  mocks.drop.mockReset()
  mocks.store.reorderUnifiedTabs.mockReset()
  mocks.store.dropUnifiedTab.mockReset()
  vi.stubGlobal('window', {
    api: {
      ui: {
        onCloseSessionTab: () => () => {},
        onSessionTabCloseRequest: () => () => {},
        onMoveSessionTab: (callback: (move: Move) => void) => {
          onMove = callback
          return () => {}
        }
      }
    }
  })
  registerSessionTabIpcBridge([])
})

const WT = 'repo1::/path/wt1'

describe('a paired client tab move in a layout-owner build', () => {
  it('goes to main first, as a tab-bar drop does', () => {
    mocks.drop.mockReturnValue(true)

    onMove({ worktreeId: WT, kind: 'move-to-group', tabId: 't2', targetGroupId: 'g2', index: 0 })
    onMove({
      worktreeId: WT,
      kind: 'split',
      tabId: 't2',
      targetGroupId: 'g1',
      splitDirection: 'right'
    })

    expect(mocks.drop.mock.calls).toEqual([
      [WT, { kind: 'move', tabId: 't2', groupId: 'g2', index: 0 }],
      [WT, { kind: 'split', tabId: 't2', groupId: 'g1', direction: 'right' }]
    ])
    expect(mocks.store.reorderUnifiedTabs).not.toHaveBeenCalled()
    expect(mocks.store.dropUnifiedTab).not.toHaveBeenCalled()
  })

  it('takes a reorder’s whole order, even one that moves tabs other than the named one', () => {
    mocks.drop.mockReturnValue(true)

    onMove({
      worktreeId: WT,
      kind: 'reorder',
      tabId: 'c',
      targetGroupId: 'g1',
      tabOrder: ['b', 'a', 'c']
    })

    // The store's reorder records the order in main as moves (tabs-layout-owner-groups-order).
    expect(mocks.drop).not.toHaveBeenCalled()
    expect(mocks.store.reorderUnifiedTabs).toHaveBeenCalledWith('g1', ['b', 'a', 'c'])
  })

  it('moves the tab here as today when main does not own the workspace', () => {
    mocks.drop.mockReturnValue(false)

    onMove({
      worktreeId: WT,
      kind: 'reorder',
      tabId: 't2',
      targetGroupId: 'g1',
      tabOrder: ['t2', 't1']
    })

    expect(mocks.store.reorderUnifiedTabs).toHaveBeenCalledWith('g1', ['t2', 't1'])
  })
})
