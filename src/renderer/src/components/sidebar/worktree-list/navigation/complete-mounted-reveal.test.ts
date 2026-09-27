// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createPendingRevealScroll,
  isRevealScrollSettling
} from '../../worktree-sidebar-reveal-scroll-settle'
import { completeMountedSidebarReveal } from './complete-mounted-reveal'

function fixture() {
  const container = document.createElement('div')
  const element = document.createElement('div')
  element.dataset.worktreeRowKey = 'target'
  container.append(element)
  Object.defineProperty(container, 'clientHeight', { value: 600, configurable: true })
  Object.defineProperty(container, 'scrollHeight', { value: 2_000, configurable: true })
  element.getBoundingClientRect = () => new DOMRect(0, 1_000 - container.scrollTop, 200, 100)
  const scrollTo = vi.fn((options: ScrollToOptions) => {
    container.scrollTop = options.top ?? container.scrollTop
  })
  container.scrollTo = (...args) => {
    const options = args[0]
    scrollTo(typeof options === 'number' ? { top: args[1] } : (options ?? {}))
  }
  const state = { cancelled: false, settling: true, interrupted: false }
  const frames: FrameRequestCallback[] = []
  const args = {
    container,
    element,
    behavior: 'smooth' as const,
    cancelled: () => state.cancelled,
    isScrollSettling: () => state.settling,
    wasScrollInterrupted: () => state.interrupted,
    markRevealScroll: vi.fn<(targetTop: number) => void>(),
    scheduleFrame: (frame: FrameRequestCallback) => frames.push(frame),
    beginRename: vi.fn(),
    complete: vi.fn()
  }
  return { args, state, frames, scrollTo, frame: () => frames.shift()?.(0) }
}

afterEach(() => vi.restoreAllMocks())

describe('mounted reveal completion', () => {
  it('completes above the stacked target headers while opening rename immediately', () => {
    const { args, state, frame, scrollTo } = fixture()
    args.element.dataset.sidebarRevealTopInset = '70'
    args.container.scrollTop = 1_200
    completeMountedSidebarReveal(args)
    expect(args.beginRename).toHaveBeenCalledOnce()
    state.settling = false
    frame()
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 930, behavior: 'auto' })
    frame()
    expect(args.element.getBoundingClientRect().top).toBe(70)
    expect(args.complete).toHaveBeenCalledExactlyOnceWith(true)
  })

  it.each([1, -1])(
    'does not correct moving native scroll after the settle hint expires (direction %s)',
    (direction) => {
      const now = vi.spyOn(window.performance, 'now').mockReturnValue(0)
      const { args, state, frame, scrollTo } = fixture()
      args.container.scrollTop = direction === 1 ? 0 : 2_000
      const pending = createPendingRevealScroll(direction === 1 ? 500 : 966, 0)
      args.isScrollSettling = () =>
        isRevealScrollSettling({
          now: window.performance.now(),
          pending,
          scrollTop: args.container.scrollTop
        })
      completeMountedSidebarReveal(args)
      now.mockReturnValue(1_050)
      state.settling = false
      args.container.scrollTop += direction * 100
      frame()
      expect(scrollTo).not.toHaveBeenCalled()
      expect(args.complete).not.toHaveBeenCalled()
      args.container.scrollTop += direction * 50
      frame()
      expect(scrollTo).not.toHaveBeenCalled()
      frame()
      expect(scrollTo).not.toHaveBeenCalled()
      now.mockReturnValue(1_151)
      frame()
      frame()
      expect(args.complete).toHaveBeenCalledExactlyOnceWith(true)
    }
  )

  it('retains the request through smooth movement and corrects the measured landing before completing', () => {
    const { args, state, frame, scrollTo } = fixture()
    completeMountedSidebarReveal(args)
    frame()
    expect(args.complete).not.toHaveBeenCalled()
    expect(scrollTo).not.toHaveBeenCalled()
    state.settling = false
    frame()
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 500, behavior: 'auto' })
    expect(args.complete).not.toHaveBeenCalled()
    expect(args.beginRename).toHaveBeenCalledOnce()
    frame()
    expect(args.complete).toHaveBeenCalledExactlyOnceWith(true)
    expect(args.beginRename).toHaveBeenCalledOnce()
  })

  it('opens editing before any smooth frames without completing the reveal', () => {
    const { args, frame } = fixture()
    completeMountedSidebarReveal(args)
    expect(args.beginRename).toHaveBeenCalledOnce()
    expect(args.complete).not.toHaveBeenCalled()
    frame()
    expect(args.beginRename).toHaveBeenCalledOnce()
    expect(args.complete).not.toHaveBeenCalled()
  })

  it('stops immediately when rename admission replaces its owner', () => {
    const { args, state, frames, scrollTo } = fixture()
    args.beginRename.mockImplementation(() => {
      state.cancelled = true
    })
    completeMountedSidebarReveal(args)
    expect(frames).toHaveLength(0)
    expect(scrollTo).not.toHaveBeenCalled()
    expect(args.complete).not.toHaveBeenCalled()
  })

  it('rechecks containment after rename admission', () => {
    const { args, frames } = fixture()
    args.beginRename.mockImplementation(() => args.element.remove())
    completeMountedSidebarReveal(args)
    expect(frames).toHaveLength(0)
    expect(args.complete).toHaveBeenCalledExactlyOnceWith(false)
  })

  it('completes an immediate reveal without scheduling animation frames', () => {
    const { args, state, frames } = fixture()
    state.settling = false
    completeMountedSidebarReveal(args)
    expect(args.complete).toHaveBeenCalledExactlyOnceWith(true)
    expect(frames).toHaveLength(0)
    expect(args.beginRename).toHaveBeenCalledOnce()
  })

  it('yields scrolling and highlight to direct input while preserving rename', () => {
    const { args, state, frame, scrollTo } = fixture()
    completeMountedSidebarReveal(args)
    state.interrupted = true
    frame()
    expect(scrollTo).not.toHaveBeenCalled()
    expect(args.complete).toHaveBeenCalledExactlyOnceWith(false)
    expect(args.beginRename).toHaveBeenCalledOnce()
  })

  it.each([true, false])(
    'cancels after unmount or a replacement request (before settling: %s)',
    (beforeSettling) => {
      const { args, state, frame } = fixture()
      completeMountedSidebarReveal(args)
      if (!beforeSettling) {
        state.settling = false
        frame()
      }
      state.cancelled = true
      frame()
      expect(args.complete).not.toHaveBeenCalled()
      expect(args.beginRename).toHaveBeenCalledOnce()
    }
  )

  it.each([true, false])(
    'only exposes the interrupted editor while it owns focus: %s',
    (focused) => {
      const { args, state, frame, scrollTo } = fixture()
      document.body.append(args.container)
      const input = document.createElement('input')
      input.dataset.worktreeTitleRenameInput = 'true'
      input.value = 'draft'
      input.getBoundingClientRect = () => new DOMRect(0, 1_000, 200, 20)
      args.element.append(input)
      completeMountedSidebarReveal(args)
      if (focused) {
        input.focus()
      }
      state.interrupted = true
      frame()
      expect(scrollTo).toHaveBeenCalledTimes(focused ? 1 : 0)
      expect(args.beginRename).toHaveBeenCalledOnce()
      expect(input.value).toBe('draft')
      expect(args.complete).toHaveBeenCalledExactlyOnceWith(false)
      args.container.remove()
    }
  )

  it('does not expose a descendant editor after the requested editor closes', () => {
    const { args, state, frame, scrollTo } = fixture()
    document.body.append(args.container)
    const child = document.createElement('div')
    child.dataset.worktreeRowKey = 'child'
    const input = document.createElement('input')
    input.dataset.worktreeTitleRenameInput = 'true'
    input.getBoundingClientRect = () => new DOMRect(0, 1_000, 200, 20)
    child.append(input)
    args.element.append(child)
    completeMountedSidebarReveal(args)
    input.focus()
    state.interrupted = true
    frame()
    expect(scrollTo).not.toHaveBeenCalled()
    expect(args.complete).toHaveBeenCalledExactlyOnceWith(false)
    args.container.remove()
  })

  it('preserves rename if input interrupts the final correction frame', () => {
    const { args, state, frame } = fixture()
    completeMountedSidebarReveal(args)
    state.settling = false
    frame()
    state.interrupted = true
    frame()
    expect(args.complete).toHaveBeenCalledExactlyOnceWith(false)
    expect(args.beginRename).toHaveBeenCalledOnce()
  })

  it('does not reopen a removed target when scrolling is interrupted', () => {
    const { args, state, frame } = fixture()
    completeMountedSidebarReveal(args)
    args.element.remove()
    state.interrupted = true
    frame()
    expect(args.complete).toHaveBeenCalledExactlyOnceWith(false)
    expect(args.beginRename).toHaveBeenCalledOnce()
  })

  it('does not reopen an element removed before the final scroll', () => {
    const { args, state, frame } = fixture()
    completeMountedSidebarReveal(args)
    args.element.remove()
    state.settling = false
    frame()
    frame()
    expect(args.complete).toHaveBeenCalledExactlyOnceWith(false)
    expect(args.beginRename).toHaveBeenCalledOnce()
  })

  it.each(['ignored', 'overwritten', 'shifted'])(
    'verifies a %s correction before completing',
    (kind) => {
      const { args, state, frame, scrollTo } = fixture()
      completeMountedSidebarReveal(args)
      state.settling = false
      if (kind === 'ignored') {
        scrollTo.mockImplementationOnce(() => {})
      }
      frame()
      if (kind === 'overwritten') {
        args.container.scrollTop = 0
      }
      if (kind === 'shifted') {
        args.element.getBoundingClientRect = () =>
          new DOMRect(0, 1_020 - args.container.scrollTop, 200, 100)
      }
      frame()
      expect(args.complete).not.toHaveBeenCalled()
      expect(scrollTo).toHaveBeenCalledTimes(2)
      frame()
      expect(args.complete).toHaveBeenCalledExactlyOnceWith(true)
      expect(args.element.getBoundingClientRect().bottom).toBe(600)
    }
  )

  it('bounds correction retries when the scroller never accepts a write', () => {
    const { args, state, frame, frames, scrollTo } = fixture()
    scrollTo.mockImplementation(() => {})
    completeMountedSidebarReveal(args)
    state.settling = false
    for (let index = 0; index < 12; index++) {
      frame()
    }
    expect(args.complete).toHaveBeenCalledExactlyOnceWith(false)
    expect(frames).toHaveLength(0)
  })

  it('accepts the browser top clamp without changing the requested inset', () => {
    const { args, state, frame } = fixture()
    args.container.scrollTop = 500
    args.element.getBoundingClientRect = () =>
      new DOMRect(0, 10 - args.container.scrollTop, 200, 100)
    completeMountedSidebarReveal(args)
    state.settling = false
    frame()
    frame()
    expect(args.container.scrollTop).toBe(0)
    expect(args.complete).toHaveBeenCalledExactlyOnceWith(true)
  })

  it('keeps the top edge of an oversized card visible without oscillating between edges', () => {
    const { args, state, frame } = fixture()
    args.container.scrollTop = 500
    args.element.getBoundingClientRect = () =>
      new DOMRect(0, 100 - args.container.scrollTop, 200, 800)
    completeMountedSidebarReveal(args)
    state.settling = false
    frame()
    frame()
    expect(args.element.getBoundingClientRect().top).toBe(34)
    expect(args.complete).toHaveBeenCalledExactlyOnceWith(true)
  })

  it('ignores a cancelled request even when no scroll is settling', () => {
    const { args, state, frames } = fixture()
    state.settling = false
    state.cancelled = true
    completeMountedSidebarReveal(args)
    expect(args.complete).not.toHaveBeenCalled()
    expect(args.beginRename).not.toHaveBeenCalled()
    expect(frames).toHaveLength(0)
  })

  it('preserves rename without claiming a landing when input precedes immediate completion', () => {
    const { args, state, frame } = fixture()
    state.settling = false
    state.interrupted = true
    completeMountedSidebarReveal(args)
    expect(args.complete).not.toHaveBeenCalled()
    frame()
    expect(args.complete).toHaveBeenCalledExactlyOnceWith(false)
    expect(args.beginRename).toHaveBeenCalledOnce()
  })

  it('cancels the initial interrupted completion when its owner is replaced', () => {
    const { args, state, frame, scrollTo } = fixture()
    state.interrupted = true
    completeMountedSidebarReveal(args)
    expect(args.beginRename).toHaveBeenCalledOnce()
    state.cancelled = true
    frame()
    expect(args.complete).not.toHaveBeenCalled()
    expect(scrollTo).not.toHaveBeenCalled()
  })

  it('does not report an already removed immediate target as landed', () => {
    const { args, state } = fixture()
    state.settling = false
    args.element.remove()
    completeMountedSidebarReveal(args)
    expect(args.complete).toHaveBeenCalledExactlyOnceWith(false)
    expect(args.beginRename).not.toHaveBeenCalled()
  })

  it('completes a settled retarget using the latest native target', () => {
    const now = vi.spyOn(window.performance, 'now').mockReturnValue(0)
    const { args, frame, frames, scrollTo } = fixture()
    let pending = createPendingRevealScroll(500, 0)
    args.markRevealScroll.mockImplementation((targetTop: number) => {
      pending = createPendingRevealScroll(targetTop, window.performance.now())
    })
    args.isScrollSettling = () =>
      isRevealScrollSettling({
        now: window.performance.now(),
        pending,
        scrollTop: args.container.scrollTop
      })
    completeMountedSidebarReveal(args)
    args.element.getBoundingClientRect = () =>
      new DOMRect(0, 900 - args.container.scrollTop, 200, 100)
    frame()
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 400, behavior: 'smooth' })
    now.mockReturnValue(2_001)
    frame()
    frame()
    expect(args.complete).toHaveBeenCalledExactlyOnceWith(true)
    expect(frames).toHaveLength(0)
  })

  it('rechecks a fitting card that grows below the fold without moving its top', () => {
    const { args, state, frame, scrollTo } = fixture()
    completeMountedSidebarReveal(args)
    state.settling = false
    frame()
    args.element.getBoundingClientRect = () =>
      new DOMRect(0, 1_000 - args.container.scrollTop, 200, 200)
    frame()
    expect(args.complete).not.toHaveBeenCalled()
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 600, behavior: 'auto' })
    frame()
    expect(args.complete).toHaveBeenCalledExactlyOnceWith(true)
    expect(args.element.getBoundingClientRect().bottom).toBe(600)
  })

  it('rechecks the measured title when growth and viewport shrink clip it after correction', () => {
    const { args, state, frame } = fixture()
    const title = document.createElement('span')
    title.dataset.worktreeTitleInlineRename = ''
    title.getBoundingClientRect = () =>
      new DOMRect(0, args.element.getBoundingClientRect().top, 200, 20)
    args.element.append(title)
    completeMountedSidebarReveal(args)
    state.settling = false
    frame()
    args.element.getBoundingClientRect = () =>
      new DOMRect(0, 1_000 - args.container.scrollTop, 200, 800)
    Object.defineProperty(args.container, 'clientHeight', { value: 510 })
    frame()
    expect(args.complete).not.toHaveBeenCalled()
    frame()
    expect(title.getBoundingClientRect().bottom).toBeLessThanOrEqual(510)
    expect(args.complete).toHaveBeenCalledExactlyOnceWith(true)
  })

  it('keeps the visible title when a corrected card grows larger than the viewport', () => {
    const { args, state, frame, scrollTo } = fixture()
    completeMountedSidebarReveal(args)
    state.settling = false
    frame()
    args.element.getBoundingClientRect = () =>
      new DOMRect(0, 1_000 - args.container.scrollTop, 200, 800)
    frame()
    expect(args.complete).toHaveBeenCalledExactlyOnceWith(true)
    expect(scrollTo).toHaveBeenCalledOnce()
    expect(args.element.getBoundingClientRect().top).toBe(500)
  })

  it('rechecks the bottom edge when the viewport shrinks after correction', () => {
    const { args, state, frame } = fixture()
    completeMountedSidebarReveal(args)
    state.settling = false
    frame()
    Object.defineProperty(args.container, 'clientHeight', { value: 550 })
    frame()
    expect(args.complete).not.toHaveBeenCalled()
    frame()
    expect(args.complete).toHaveBeenCalledExactlyOnceWith(true)
    expect(args.element.getBoundingClientRect().bottom).toBe(550)
  })

  it('accepts the attainable title of a bottom-clamped oversized card', () => {
    const { args, state, frame, scrollTo } = fixture()
    args.element.getBoundingClientRect = () =>
      new DOMRect(0, 1_600 - args.container.scrollTop, 200, 800)
    scrollTo.mockImplementation((options: ScrollToOptions) => {
      args.container.scrollTop = Math.min(options.top ?? 0, 1_400)
    })
    completeMountedSidebarReveal(args)
    state.settling = false
    frame()
    frame()
    expect(args.container.scrollTop).toBe(1_400)
    expect(args.element.getBoundingClientRect().top).toBe(200)
    expect(args.complete).toHaveBeenCalledExactlyOnceWith(true)
  })

  it('does not claim a fitting card landed when a bottom clamp keeps its end clipped', () => {
    const { args, state, frame, scrollTo } = fixture()
    args.element.getBoundingClientRect = () =>
      new DOMRect(0, 1_950 - args.container.scrollTop, 200, 100)
    scrollTo.mockImplementation((options: ScrollToOptions) => {
      args.container.scrollTop = Math.min(options.top ?? 0, 1_400)
    })
    completeMountedSidebarReveal(args)
    state.settling = false
    for (let index = 0; index < 12; index++) {
      frame()
    }
    expect(args.complete).toHaveBeenCalledExactlyOnceWith(false)
  })
})
