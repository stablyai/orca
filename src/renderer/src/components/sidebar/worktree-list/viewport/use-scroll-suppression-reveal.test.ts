// @vitest-environment happy-dom
import { act, renderHook, cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useWorktreeSidebarScrollSuppression } from './use-scroll-suppression'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('native reveal anchor suppression', () => {
  it.each(['anchor-first', 'completion-first'] as const)(
    'preserves motion across the hint deadline with %s sampling',
    (order) => {
      const now = vi.spyOn(window.performance, 'now').mockReturnValue(0)
      const container = document.createElement('div')
      const hook = renderHook(() => useWorktreeSidebarScrollSuppression({ current: container }))
      act(() => hook.result.current.markRevealScroll(20_000))
      expect(hook.result.current.isRevealScrollSettling()).toBe(true)
      const sample = () =>
        order === 'anchor-first'
          ? [
              hook.result.current.shouldSkipScrollAnchorRestore(),
              hook.result.current.isRevealScrollSettling()
            ]
          : [
              hook.result.current.isRevealScrollSettling(),
              hook.result.current.shouldSkipScrollAnchorRestore()
            ]
      now.mockReturnValue(980)
      container.scrollTop = 10_000
      expect(sample()).toEqual([true, true])
      now.mockReturnValue(1_000)
      expect(sample()).toEqual([true, true])
      now.mockReturnValue(1_030)
      container.scrollTop = 11_000
      expect(sample()).toEqual([true, true])
      act(() => hook.result.current.markDirectScrollInput())
      expect(hook.result.current.wasRevealScrollInterrupted()).toBe(true)
      now.mockReturnValue(1_040)
      container.scrollTop = 11_010
      expect(sample()).toEqual([true, true])
      expect(hook.result.current.wasRevealScrollInterrupted()).toBe(true)
      now.mockReturnValue(2_001)
      expect(sample()).toEqual([false, false])
    }
  )
})
