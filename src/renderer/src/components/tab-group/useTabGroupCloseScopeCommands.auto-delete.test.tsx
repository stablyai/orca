// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { makeTabGroup, makeUnifiedTab } from '../../store/slices/store-session-test-harness'
import { useTabGroupCloseScopeCommands } from './useTabGroupCloseScopeCommands'

const capture = vi.hoisted(() =>
  vi.fn((..._args: unknown[]) => () => {})
)
vi.mock('./workspace-emptied-reaction', () => ({ captureWorkspaceEmptiedReaction: capture }))
vi.mock('../confirmation-dialog-context', () => ({ useConfirmationDialog: () => vi.fn() }))

const worktreeId = 'wt-1'
const groupId = 'group-1'

function closeGroupWithHosts(hosts: ('local' | 'ssh:box')[]): void {
  const tabs = hosts.map((executionHostId, index) =>
    makeUnifiedTab({ id: `tab-${index}`, worktreeId, groupId, executionHostId })
  )
  useAppStore.setState({
    groupsByWorktree: {
      [worktreeId]: [makeTabGroup({ id: groupId, worktreeId, tabOrder: tabs.map((t) => t.id) })]
    },
    unifiedTabsByWorktree: { [worktreeId]: tabs }
  })
  const { result } = renderHook(() =>
    useTabGroupCloseScopeCommands({ worktreeId, groupId, closeItem: vi.fn(), closeMany: vi.fn() })
  )
  result.current.closeGroup()
}

afterEach(() => {
  cleanup()
  capture.mockClear()
})

describe('closeGroup auto-delete host', () => {
  it('passes the host shared by every tab in the group', () => {
    closeGroupWithHosts(['ssh:box', 'ssh:box'])
    expect(capture).toHaveBeenCalledWith(worktreeId, { trigger: 'close', hostId: 'ssh:box' })
  })

  it('names no host when the group mixes hosts', () => {
    closeGroupWithHosts(['ssh:box', 'local'])
    expect(capture).toHaveBeenCalledWith(worktreeId, { trigger: 'close' })
  })
})
