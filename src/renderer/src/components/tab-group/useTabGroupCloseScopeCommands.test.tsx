// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { makeTabGroup, makeUnifiedTab } from '../../store/slices/store-session-test-harness'
import type { BulkTabCloseScope } from '../use-bulk-tab-close-confirmation'
import { useTabGroupCloseScopeCommands } from './useTabGroupCloseScopeCommands'

const confirm = vi.hoisted(() => vi.fn<() => Promise<boolean>>())
vi.mock('../confirmation-dialog-context', () => ({ useConfirmationDialog: () => confirm }))

const worktreeId = 'wt-1'
const groupId = 'group-1'
const left = makeUnifiedTab({ id: 'left', worktreeId, groupId, contentType: 'editor' })
const anchor = makeUnifiedTab({ id: 'anchor', worktreeId, groupId, contentType: 'terminal' })
const right = makeUnifiedTab({ id: 'right', worktreeId, groupId, contentType: 'browser' })
const pinned = makeUnifiedTab({
  id: 'pinned',
  worktreeId,
  groupId,
  contentType: 'editor',
  isPinned: true
})
const group = makeTabGroup({
  id: groupId,
  worktreeId,
  activeTabId: anchor.id,
  tabOrder: [left.id, anchor.id, right.id, pinned.id]
})
const closeItem = vi.fn()
const closeMany = vi.fn()
let settle: (confirmed: boolean) => void

beforeEach(() => {
  vi.clearAllMocks()
  confirm.mockImplementation(
    () =>
      new Promise((resolve) => {
        settle = resolve
      })
  )
  useAppStore.setState({
    groupsByWorktree: { [worktreeId]: [group] },
    unifiedTabsByWorktree: { [worktreeId]: [left, anchor, right, pinned] }
  })
})
afterEach(cleanup)

function request(scope: BulkTabCloseScope) {
  const { result } = renderHook(() =>
    useTabGroupCloseScopeCommands({
      worktreeId,
      groupId,
      closeItem,
      closeMany
    })
  )
  const actions = {
    editors: result.current.closeAllEditorTabsInGroup,
    others: () => result.current.closeOthers(anchor.id),
    right: () => result.current.closeToRight(anchor.id),
    left: () => result.current.closeToLeft(anchor.id)
  }
  act(actions[scope])
}

async function confirmRequest(confirmed = true) {
  await act(async () => {
    settle(confirmed)
  })
}

describe('group bulk close confirmation', () => {
  it.each(['editors', 'others', 'right', 'left'] as const)(
    'waits for confirmation and leaves tabs untouched on cancelling %s',
    async (scope) => {
      request(scope)
      expect(confirm).toHaveBeenCalledOnce()
      expect(closeItem).not.toHaveBeenCalled()
      expect(closeMany).not.toHaveBeenCalled()
      await confirmRequest(false)
      expect(closeItem).not.toHaveBeenCalled()
      expect(closeMany).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['others', ['left', 'right']],
    ['right', ['right']],
    ['left', ['left']]
  ] as const)('closes the unpinned %s selection on confirmation', async (scope, ids) => {
    request(scope)
    await confirmRequest()
    expect(closeMany).toHaveBeenCalledExactlyOnceWith([...ids])
    expect(closeItem).not.toHaveBeenCalled()
  })

  it('routes editor closes through the existing dirty-aware item command', async () => {
    request('editors')
    await confirmRequest()
    expect(closeItem).toHaveBeenCalledExactlyOnceWith(left.id)
    expect(closeMany).not.toHaveBeenCalled()
  })

  it.each(['others', 'right', 'left'] as const)(
    'abandons %s when the anchor is removed while the dialog is open',
    async (scope) => {
      request(scope)
      act(() =>
        useAppStore.setState({
          unifiedTabsByWorktree: {
            [worktreeId]: [left, right, pinned]
          }
        })
      )
      await confirmRequest()
      expect(closeMany).not.toHaveBeenCalled()
    }
  )

  it.each(['editors', 'others', 'right', 'left'] as const)(
    'abandons %s when the original group disappears',
    async (scope) => {
      request(scope)
      act(() => useAppStore.setState({ groupsByWorktree: {} }))
      await confirmRequest()
      expect(closeMany).not.toHaveBeenCalled()
      expect(closeItem).not.toHaveBeenCalled()
    }
  )

  it('skips editors pinned while confirmation is pending', async () => {
    request('editors')
    act(() =>
      useAppStore.setState({
        unifiedTabsByWorktree: {
          [worktreeId]: [{ ...left, isPinned: true }, anchor, right, pinned]
        }
      })
    )
    await confirmRequest()
    expect(closeItem).not.toHaveBeenCalled()
  })

  it('excludes moved tabs and tabs created after the request', async () => {
    request('others')
    const added = makeUnifiedTab({ id: 'added', worktreeId, groupId })
    act(() =>
      useAppStore.setState({
        unifiedTabsByWorktree: {
          [worktreeId]: [{ ...left, groupId: 'other-group' }, anchor, right, pinned, added]
        }
      })
    )
    await confirmRequest()
    expect(closeMany).toHaveBeenCalledExactlyOnceWith([right.id])
  })

  it.each(['right', 'left'] as const)(
    'excludes tabs that cross the %s boundary while confirmation is pending',
    async (scope) => {
      request(scope)
      act(() =>
        useAppStore.setState({
          groupsByWorktree: {
            [worktreeId]: [{ ...group, tabOrder: [right.id, anchor.id, left.id, pinned.id] }]
          }
        })
      )
      await confirmRequest()
      expect(closeMany).not.toHaveBeenCalled()
    }
  )

  it('keeps the original workspace and handler when the hook changes scope', async () => {
    const otherCloseMany = vi.fn()
    const { result, rerender } = renderHook(
      (props) => useTabGroupCloseScopeCommands({ groupId, closeItem, ...props }),
      { initialProps: { worktreeId, closeMany } }
    )
    act(() => result.current.closeOthers(anchor.id))
    rerender({ worktreeId: 'wt-2', closeMany: otherCloseMany })
    await confirmRequest()
    expect(closeMany).toHaveBeenCalledExactlyOnceWith([left.id, right.id])
    expect(otherCloseMany).not.toHaveBeenCalled()
  })

  it('does not prompt when there are no eligible targets', () => {
    useAppStore.setState({ unifiedTabsByWorktree: { [worktreeId]: [anchor, pinned] } })
    request('others')
    expect(confirm).not.toHaveBeenCalled()
  })
})
