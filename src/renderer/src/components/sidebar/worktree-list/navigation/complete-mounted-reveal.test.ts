// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { completeMountedSidebarReveal } from './complete-mounted-reveal'

function fixture() {
  const container = document.createElement('div')
  const element = document.createElement('div')
  container.append(element)
  Object.defineProperty(container, 'clientHeight', { value: 600 })
  element.getBoundingClientRect = () => new DOMRect(0, 1_000, 200, 100)
  const scrollTo = vi.fn()
  container.scrollTo = scrollTo
  const state = { cancelled: false, settling: true, interrupted: false }
  const frames: FrameRequestCallback[] = []
  const args = {
    container,
    element,
    cancelled: () => state.cancelled,
    isScrollSettling: () => state.settling,
    wasScrollInterrupted: () => state.interrupted,
    markRevealScroll: vi.fn(),
    scheduleFrame: (frame: FrameRequestCallback) => frames.push(frame),
    complete: vi.fn()
  }
  return { args, state, frames, scrollTo, frame: () => frames.shift()?.(0) }
}

describe('mounted reveal completion', () => {
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
    frame()
    expect(args.complete).toHaveBeenCalledExactlyOnceWith(true)
  })

  it('completes an immediate reveal without scheduling animation frames', () => {
    const { args, state, frames } = fixture()
    state.settling = false
    completeMountedSidebarReveal(args)
    expect(args.complete).toHaveBeenCalledExactlyOnceWith(true)
    expect(frames).toHaveLength(0)
  })

  it('yields to direct scroll input without flashing or starting rename', () => {
    const { args, state, frame, scrollTo } = fixture()
    completeMountedSidebarReveal(args)
    state.interrupted = true
    frame()
    expect(scrollTo).not.toHaveBeenCalled()
    expect(args.complete).toHaveBeenCalledExactlyOnceWith(false)
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
    }
  )

  it('does not rename an element removed before the final scroll', () => {
    const { args, state, frame } = fixture()
    completeMountedSidebarReveal(args)
    args.element.remove()
    state.settling = false
    frame()
    frame()
    expect(args.complete).toHaveBeenCalledExactlyOnceWith(false)
  })
})
