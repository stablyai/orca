import type * as ReactModule from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getForegroundTerminalWorktreeIds,
  resetForegroundTerminalWorktreeIdsForTests
} from '@/lib/foreground-terminal-worktrees'
import { useVisibleTerminalWorktreeClaim } from './use-visible-terminal-worktree-claim'

const reactEffects = vi.hoisted(() => ({
  layoutEffects: [] as (() => void | (() => void))[],
  passiveEffects: [] as (() => void | (() => void))[]
}))

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>()
  return {
    ...actual,
    useEffect: (effect: () => void | (() => void)) => {
      reactEffects.passiveEffects.push(effect)
    },
    useLayoutEffect: (effect: () => void | (() => void)) => {
      reactEffects.layoutEffects.push(effect)
    }
  }
})

afterEach(() => {
  resetForegroundTerminalWorktreeIdsForTests()
  reactEffects.layoutEffects = []
  reactEffects.passiveEffects = []
})

describe('useVisibleTerminalWorktreeClaim', () => {
  it('registers visible panes through a layout effect', () => {
    useVisibleTerminalWorktreeClaim({ isVisible: true, worktreeId: 'wt-visible' })

    expect(reactEffects.passiveEffects).toHaveLength(0)
    expect(reactEffects.layoutEffects).toHaveLength(1)

    const cleanup = reactEffects.layoutEffects[0]()
    expect(getForegroundTerminalWorktreeIds()).toEqual(['wt-visible'])

    cleanup?.()
    expect(getForegroundTerminalWorktreeIds()).toEqual([])
  })

  it('does not claim hidden panes', () => {
    useVisibleTerminalWorktreeClaim({ isVisible: false, worktreeId: 'wt-hidden' })

    reactEffects.layoutEffects[0]()

    expect(getForegroundTerminalWorktreeIds()).toEqual([])
  })
})
