import { describe, expect, it } from 'vitest'
import { shouldResetFileExplorerForVisibleWorktree } from './file-explorer-reset'

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
