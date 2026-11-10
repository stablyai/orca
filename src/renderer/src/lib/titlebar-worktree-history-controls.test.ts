import { describe, expect, it } from 'vitest'
import { shouldShowWorktreeHistoryControls } from './titlebar-worktree-history-controls'

describe('shouldShowWorktreeHistoryControls', () => {
  it('allows history on canonical plugin pages alongside existing pages', () => {
    expect(shouldShowWorktreeHistoryControls('plugin:samples.notes/dashboard')).toBe(true)
    expect(shouldShowWorktreeHistoryControls('terminal')).toBe(true)
    expect(shouldShowWorktreeHistoryControls('tasks')).toBe(true)
  })

  it.each([
    'plugin:',
    'plugin:notes/dashboard',
    'plugin:samples.notes/',
    'plugin:samples.notes/dashboard/extra'
  ] as const)('rejects malformed plugin route %s', (route) => {
    expect(shouldShowWorktreeHistoryControls(route)).toBe(false)
  })
})
