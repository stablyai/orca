// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../store'
import {
  clearDatabaseTabPassword,
  getDatabaseTabPassword,
  setDatabaseTabPassword
} from './database/database-tab-credentials'
import { useTerminalBulkCloseActions } from './use-terminal-bulk-close-actions'
import type { TerminalCloseController } from './use-terminal-close-actions'

const initialState = useAppStore.getInitialState()
const worktreeId = 'project-a'
const order = ['pinned', 'left', 'keep', 'right']

beforeEach(() => {
  useAppStore.setState({ activeWorktreeId: worktreeId })
  for (const id of order) {
    useAppStore.getState().createUnifiedTab(worktreeId, 'database', {
      id,
      isPinned: id === 'pinned',
      executionHostId: 'runtime:owner'
    })
    setDatabaseTabPassword(id, 'fixture-password', 'runtime:owner')
  }
  useAppStore.getState().createUnifiedTab('project-b', 'database', { id: 'other-project' })
  useAppStore.setState({ tabBarOrderByWorktree: { [worktreeId]: order } })
})

afterEach(() => {
  cleanup()
  useAppStore.setState(initialState, true)
  for (const id of order) {
    clearDatabaseTabPassword(id)
  }
})

describe('main titlebar database bulk close', () => {
  it.each([
    ['handleCloseOthers', ['pinned', 'keep']],
    ['handleCloseTabsToRight', ['pinned', 'left', 'keep']],
    ['handleCloseTabsToLeft', ['pinned', 'keep', 'right']]
  ] as const)(
    '%s closes database tabs and clears only their cached passwords',
    (action, remaining) => {
      const controller = {
        activeWorktreeId: worktreeId,
        closeBrowserTab: vi.fn(),
        closeFile: vi.fn(),
        closeTab: vi.fn(),
        queueEditorCloseRequests: vi.fn()
      } as unknown as TerminalCloseController
      const { result } = renderHook(() => useTerminalBulkCloseActions(controller))

      act(() => result.current[action]('keep'))

      const state = useAppStore.getState()
      expect(state.unifiedTabsByWorktree[worktreeId].map((tab) => tab.id)).toEqual(remaining)
      expect(state.unifiedTabsByWorktree['project-b'].map((tab) => tab.id)).toEqual([
        'other-project'
      ])
      for (const id of order) {
        expect(getDatabaseTabPassword(id, 'runtime:owner')).toBe(
          remaining.some((kept) => kept === id) ? 'fixture-password' : ''
        )
      }
      expect(controller.closeTab).not.toHaveBeenCalled()
      expect(controller.closeBrowserTab).not.toHaveBeenCalled()
      expect(controller.queueEditorCloseRequests).not.toHaveBeenCalled()
    }
  )
})
