import type * as ReactModule from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getForegroundTerminalTabIds,
  resetForegroundTerminalTabIdsForTests
} from '@/lib/foreground-terminal-tabs'
import { useVisibleTerminalTabClaim } from './use-visible-terminal-tab-claim'

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
  resetForegroundTerminalTabIdsForTests()
  reactEffects.layoutEffects = []
  reactEffects.passiveEffects = []
})

describe('useVisibleTerminalTabClaim', () => {
  it('registers visible panes through a layout effect', () => {
    useVisibleTerminalTabClaim({ isVisible: true, tabId: 'tab-visible' })

    expect(reactEffects.passiveEffects).toHaveLength(0)
    expect(reactEffects.layoutEffects).toHaveLength(1)

    const cleanup = reactEffects.layoutEffects[0]()
    expect(getForegroundTerminalTabIds()).toEqual(['tab-visible'])

    cleanup?.()
    expect(getForegroundTerminalTabIds()).toEqual([])
  })

  it('does not claim hidden panes', () => {
    useVisibleTerminalTabClaim({ isVisible: false, tabId: 'tab-hidden' })

    reactEffects.layoutEffects[0]()

    expect(getForegroundTerminalTabIds()).toEqual([])
  })
})
