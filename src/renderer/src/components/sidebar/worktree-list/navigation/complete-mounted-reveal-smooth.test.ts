// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createPendingRevealScroll,
  isRevealScrollSettling
} from '../../worktree-sidebar-reveal-scroll-settle'
import { completeMountedSidebarReveal } from './complete-mounted-reveal'

function fixture() {
  const now = vi.spyOn(window.performance, 'now').mockReturnValue(38)
  const container = document.createElement('div')
  const element = document.createElement('div')
  container.append(element)
  container.scrollTop = 89
  Object.defineProperty(container, 'clientHeight', { value: 743 })
  Object.defineProperty(container, 'scrollHeight', { value: 30_000 })
  const geometry = { top: 21_798 }
  container.getBoundingClientRect = () => new DOMRect(0, 0, 200, 743)
  element.getBoundingClientRect = () => new DOMRect(0, geometry.top - container.scrollTop, 200, 55)
  let pending = createPendingRevealScroll(21_110, 38)
  const scrollTo = vi.fn((options: ScrollToOptions) => {
    if (options.behavior === 'auto') {
      container.scrollTop = options.top ?? container.scrollTop
    }
  })
  container.scrollTo = (...args) => {
    const options = args[0]
    scrollTo(typeof options === 'number' ? { top: args[1] } : (options ?? {}))
  }
  const frames: FrameRequestCallback[] = []
  const state = { cancelled: false, interrupted: false }
  const args = {
    container,
    element,
    behavior: 'smooth' as const,
    cancelled: () => state.cancelled,
    wasScrollInterrupted: () => state.interrupted,
    isScrollSettling: () =>
      isRevealScrollSettling({
        now: window.performance.now(),
        pending,
        scrollTop: container.scrollTop
      }),
    markRevealScroll: (targetTop: number) => {
      pending = createPendingRevealScroll(targetTop, window.performance.now())
    },
    scheduleFrame: (frame: FrameRequestCallback) => frames.push(frame),
    beginRename: vi.fn(),
    complete: vi.fn()
  }
  const frame = (time: number, offset: number) => {
    now.mockReturnValue(time)
    container.scrollTop = offset
    frames.shift()?.(time)
  }
  completeMountedSidebarReveal(args)
  geometry.top = 20_773
  frame(1_520.6, 18_837)
  expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 20_085, behavior: 'smooth' })
  return { args, container, element, geometry, scrollTo, frames, frame, state }
}

afterEach(() => vi.restoreAllMocks())

describe('latest native motion owns mounted reveal completion', () => {
  it('does not auto-correct the recorded seven-pixel approach across the original ceiling', () => {
    const f = fixture()
    expect(f.args.beginRename).toHaveBeenCalledOnce()
    for (const [time, offset] of [
      [1_986.4, 20_057],
      [2_002.3, 20_064],
      [2_019.7, 20_070],
      [2_035.6, 20_074],
      [2_052.4, 20_078]
    ]) {
      f.frame(time, offset)
      expect(f.scrollTo).toHaveBeenCalledOnce()
      expect(f.args.complete).not.toHaveBeenCalled()
    }
    f.frame(2_069.3, 20_085)
    f.frame(2_085.4, 20_085)
    expect(f.scrollTo).toHaveBeenCalledOnce()
    expect(f.args.complete).toHaveBeenCalledExactlyOnceWith(true)
    expect(f.frames).toHaveLength(0)
  })

  it.each(['quiet', 'progressing'] as const)(
    'bounds retarget issuance and finishes an unreachable %s target with existing settle limits',
    (motion) => {
      const f = fixture()
      f.geometry.top += 100
      f.frame(2_052.4, 20_000)
      f.frame(2_520.6, motion === 'quiet' ? 20_000 : 20_001)
      if (motion === 'progressing') {
        for (let time = 2_570.6; time < 3_520.6; time += 50) {
          f.frame(time, f.container.scrollTop + 1)
        }
        expect(f.scrollTo).toHaveBeenCalledOnce()
        expect(f.args.complete).not.toHaveBeenCalled()
        f.frame(3_520.6, f.container.scrollTop + 1)
      }
      expect(f.scrollTo).toHaveBeenCalledTimes(2)
      expect(f.scrollTo).toHaveBeenLastCalledWith({ top: 20_185, behavior: 'auto' })
      f.frame(3_537, 20_185)
      expect(f.args.complete).toHaveBeenCalledExactlyOnceWith(true)
      expect(f.frames).toHaveLength(0)
    }
  )

  it.each(['cancelled', 'interrupted', 'unmounted'] as const)(
    'still yields to %s after the retarget ceiling',
    (reason) => {
      const f = fixture()
      f.frame(2_052.4, 20_078)
      if (reason === 'unmounted') {
        f.element.remove()
      } else {
        f.state[reason] = true
      }
      f.frame(2_069.3, 20_080)
      expect(f.scrollTo).toHaveBeenCalledOnce()
      if (reason === 'cancelled') {
        expect(f.args.complete).not.toHaveBeenCalled()
      } else {
        expect(f.args.complete).toHaveBeenCalledExactlyOnceWith(false)
      }
      expect(f.args.beginRename).toHaveBeenCalledOnce()
      expect(f.frames).toHaveLength(0)
    }
  )
})
