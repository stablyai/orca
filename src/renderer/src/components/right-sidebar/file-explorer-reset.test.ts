import { describe, expect, it } from 'vitest'
import {
  getVisibleFileExplorerWorktreePath,
  shouldResetFileExplorerForVisibleWorktree
} from './file-explorer-reset'

describe('getVisibleFileExplorerWorktreePath', () => {
  it('exposes the worktree path only while the Files view is visible', () => {
    expect(
      getVisibleFileExplorerWorktreePath({
        explorerView: 'files',
        rightSidebarOpen: true,
        worktreePath: '/repo'
      })
    ).toBe('/repo')
    expect(
      getVisibleFileExplorerWorktreePath({
        explorerView: 'search',
        rightSidebarOpen: true,
        worktreePath: '/repo'
      })
    ).toBeNull()
    expect(
      getVisibleFileExplorerWorktreePath({
        explorerView: 'files',
        rightSidebarOpen: false,
        worktreePath: '/repo'
      })
    ).toBeNull()
  })
})

describe('shouldResetFileExplorerForVisibleWorktree', () => {
  it('preserves explorer state across hide and reopen of the same worktree', () => {
    let lastResetWorktreePath: string | null = null
    const shouldReset = (visibleWorktreePath: string | null): boolean => {
      if (shouldResetFileExplorerForVisibleWorktree(lastResetWorktreePath, visibleWorktreePath)) {
        lastResetWorktreePath = visibleWorktreePath
        return true
      }
      return false
    }

    expect(shouldReset(null)).toBe(false)
    expect(shouldReset('/repo')).toBe(true)
    expect(shouldReset(null)).toBe(false)
    expect(shouldReset('/repo')).toBe(false)
  })

  it('resets when the visible worktree path changes', () => {
    expect(shouldResetFileExplorerForVisibleWorktree('/repo', '/repo-next')).toBe(true)
  })
})
