// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPreviewBoxFit } from './preview-terminal-box-fit'
import { buildPreviewFitHost, dimension } from './preview-fit-test-host'

function terminalAt(rows: number, cursorY: number): never {
  return { rows, buffer: { active: { cursorY } } } as never
}

describe('createPreviewBoxFit', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    // happy-dom has no rAF loop under fake timers; run callbacks as macrotasks.
    vi.stubGlobal(
      'requestAnimationFrame',
      (cb: FrameRequestCallback) => setTimeout(() => cb(0), 16) as unknown as number
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('keeps the last good fit when the node measures zero', async () => {
    const { box, container, screen } = buildPreviewFitHost()
    dimension(box, 'clientWidth', 400)
    dimension(box, 'clientHeight', 300)
    dimension(screen, 'offsetWidth', 800)
    dimension(screen, 'offsetHeight', 384)
    const boxFit = createPreviewBoxFit({ container, getTerminal: () => terminalAt(24, 0) })

    boxFit.fit()
    expect(container.style.transform).toBe('scale(0.5)')
    expect(box.style.alignItems).toBe('flex-start')

    // A dnd reorder moves DOM nodes: the ResizeObserver fires while detached.
    dimension(screen, 'offsetWidth', 0)
    dimension(screen, 'offsetHeight', 0)
    boxFit.fit()

    expect(container.style.transform).toBe('scale(0.5)')
    expect(box.style.alignItems).toBe('flex-start')
  })

  it('re-measures on its own once the layout becomes usable again', async () => {
    const { box, container, screen } = buildPreviewFitHost()
    dimension(box, 'clientWidth', 400)
    dimension(box, 'clientHeight', 300)
    dimension(screen, 'offsetWidth', 0)
    dimension(screen, 'offsetHeight', 0)
    const boxFit = createPreviewBoxFit({ container, getTerminal: () => terminalAt(24, 0) })

    // An idle terminal never writes again, so nothing external would re-fit it.
    boxFit.fit()
    expect(container.style.transform).toBe('')

    dimension(screen, 'offsetWidth', 800)
    dimension(screen, 'offsetHeight', 384)
    await vi.advanceTimersByTimeAsync(64)

    expect(container.style.transform).toBe('scale(0.5)')
  })

  it('leaves a frame that only overflows vertically alone on the width axis', () => {
    const { box, container, screen } = buildPreviewFitHost()
    dimension(box, 'clientWidth', 800)
    dimension(box, 'clientHeight', 200)
    dimension(screen, 'offsetWidth', 800)
    dimension(screen, 'offsetHeight', 384)
    const boxFit = createPreviewBoxFit({ container, getTerminal: () => terminalAt(24, 0) })

    boxFit.fit()

    expect(container.style.transform).toBe('')
  })

  it('shrinks the same frame on the height axis when fitting both', () => {
    const { box, container, screen } = buildPreviewFitHost()
    dimension(box, 'clientWidth', 800)
    dimension(box, 'clientHeight', 192)
    dimension(screen, 'offsetWidth', 800)
    dimension(screen, 'offsetHeight', 384)
    const boxFit = createPreviewBoxFit({
      container,
      getTerminal: () => terminalAt(24, 0),
      fitAxis: 'both'
    })

    boxFit.fit()

    expect(container.style.transform).toBe('scale(0.5)')
  })

  it('never scales up to fill a box larger than the frame', () => {
    const { box, container, screen } = buildPreviewFitHost()
    dimension(box, 'clientWidth', 1600)
    dimension(box, 'clientHeight', 800)
    dimension(screen, 'offsetWidth', 800)
    dimension(screen, 'offsetHeight', 384)
    const boxFit = createPreviewBoxFit({
      container,
      getTerminal: () => terminalAt(24, 0),
      fitAxis: 'both'
    })

    boxFit.fit()

    expect(container.style.transform).toBe('')
  })

  it('anchors the bottom when the cursor sits past the box', () => {
    const { box, container, screen } = buildPreviewFitHost()
    dimension(box, 'clientWidth', 800)
    dimension(box, 'clientHeight', 100)
    dimension(screen, 'offsetWidth', 800)
    dimension(screen, 'offsetHeight', 384)
    const boxFit = createPreviewBoxFit({ container, getTerminal: () => terminalAt(24, 23) })

    boxFit.fit()

    expect(box.style.alignItems).toBe('flex-end')
    expect(container.style.transformOrigin).toBe('bottom left')
  })
})
