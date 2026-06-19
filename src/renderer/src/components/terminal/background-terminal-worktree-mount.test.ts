import { describe, expect, it, vi } from 'vitest'

import { addBackgroundMountedTerminalWorktree } from './background-terminal-worktree-mount'

describe('addBackgroundMountedTerminalWorktree', () => {
  it('adds a hidden worktree mount and notifies the caller once', () => {
    const mountedWorktreeIds = new Set<string>()
    const onAdded = vi.fn()

    expect(addBackgroundMountedTerminalWorktree(mountedWorktreeIds, 'wt-1', onAdded)).toBe(true)
    expect(mountedWorktreeIds.has('wt-1')).toBe(true)
    expect(onAdded).toHaveBeenCalledTimes(1)

    expect(addBackgroundMountedTerminalWorktree(mountedWorktreeIds, 'wt-1', onAdded)).toBe(false)
    expect(onAdded).toHaveBeenCalledTimes(1)
  })

  it('ignores missing worktree ids', () => {
    const mountedWorktreeIds = new Set<string>()
    const onAdded = vi.fn()

    expect(addBackgroundMountedTerminalWorktree(mountedWorktreeIds, undefined, onAdded)).toBe(false)
    expect(mountedWorktreeIds.size).toBe(0)
    expect(onAdded).not.toHaveBeenCalled()
  })
})
