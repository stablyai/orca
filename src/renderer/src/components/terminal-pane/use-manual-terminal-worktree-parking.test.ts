import { describe, expect, it, afterEach, vi } from 'vitest'
import { combineTerminalWorktreeParkIds } from './use-manual-terminal-worktree-parking'

describe('combineTerminalWorktreeParkIds', () => {
  it('adds manually parked worktrees without dropping automatic parks', () => {
    expect(combineTerminalWorktreeParkIds(new Set(['automatic']), new Set(['manual']))).toEqual(
      new Set(['automatic', 'manual'])
    )
  })

  it('keeps the automatic set reference when there are no manual parks', () => {
    const automatic = new Set(['automatic'])

    expect(combineTerminalWorktreeParkIds(automatic, new Set())).toBe(automatic)
  })
})

const { rejectAppStoreAccess } = vi.hoisted(() => ({
  rejectAppStoreAccess: vi.fn(() => {
    throw new Error('Pure helper tests must not access the app store')
  })
}))

vi.mock('@/store', () => ({
  useAppStore: Object.assign(rejectAppStoreAccess, {
    getState: rejectAppStoreAccess,
    getInitialState: rejectAppStoreAccess,
    setState: rejectAppStoreAccess,
    subscribe: rejectAppStoreAccess
  })
}))

afterEach(() => {
  expect(rejectAppStoreAccess).not.toHaveBeenCalled()
})
