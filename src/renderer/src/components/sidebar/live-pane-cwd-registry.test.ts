import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearLivePaneCwd,
  getLivePaneCwd,
  getLivePaneCwdVersion,
  resetLivePaneCwdRegistryForTests,
  setLivePaneCwd,
  subscribeLivePaneCwd
} from './live-pane-cwd-registry'

afterEach(() => {
  resetLivePaneCwdRegistryForTests()
})

describe('live-pane-cwd-registry', () => {
  it('stores confirmed cwd and notifies subscribers once per change', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeLivePaneCwd(listener)
    const before = getLivePaneCwdVersion()

    setLivePaneCwd('tab:leaf', '/repo/worktree-a')
    setLivePaneCwd('tab:leaf', '/repo/worktree-a')
    expect(getLivePaneCwd('tab:leaf')).toBe('/repo/worktree-a')
    expect(getLivePaneCwdVersion()).toBe(before + 1)
    expect(listener).toHaveBeenCalledTimes(1)

    setLivePaneCwd('tab:leaf', '/repo/worktree-b')
    expect(getLivePaneCwdVersion()).toBe(before + 2)
    expect(listener).toHaveBeenCalledTimes(2)

    clearLivePaneCwd('tab:leaf')
    expect(getLivePaneCwd('tab:leaf')).toBeUndefined()
    expect(listener).toHaveBeenCalledTimes(3)
    unsubscribe()
  })
})
