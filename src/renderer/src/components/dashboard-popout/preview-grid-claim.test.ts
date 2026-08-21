// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPreviewGridClaim } from './preview-grid-claim'

function dimension(element: HTMLElement, name: string, value: number): void {
  Object.defineProperty(element, name, { configurable: true, value })
}

describe('createPreviewGridClaim', () => {
  afterEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  it('waits for a resize signal instead of polling while layout is unmeasurable', async () => {
    vi.useFakeTimers()
    const fit = vi.fn(async () => ({ cols: 90, rows: 30 }))
    Object.assign(window, { api: { terminalPreview: { fit } } })
    const box = document.createElement('div')
    const container = document.createElement('div')
    const screen = document.createElement('div')
    screen.className = 'xterm-screen'
    box.appendChild(container)
    container.appendChild(screen)
    dimension(box, 'clientWidth', 900)
    dimension(box, 'clientHeight', 480)
    dimension(screen, 'offsetWidth', 0)
    dimension(screen, 'offsetHeight', 0)
    const claim = createPreviewGridClaim({
      ptyId: 'pty-1',
      container,
      getTerminal: () => ({ cols: 80, rows: 24 }) as never
    })

    claim.schedule()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(fit).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)

    dimension(screen, 'offsetWidth', 800)
    dimension(screen, 'offsetHeight', 384)
    claim.schedule()
    await vi.advanceTimersByTimeAsync(200)
    expect(fit).toHaveBeenCalledWith('pty-1', 90, 30)
    claim.dispose()
  })

  it('coalesces a continuous resize burst into one settled fit request', async () => {
    vi.useFakeTimers()
    const fit = vi.fn(async (_ptyId: string, cols: number, rows: number) => ({ cols, rows }))
    Object.assign(window, { api: { terminalPreview: { fit } } })
    const box = document.createElement('div')
    const container = document.createElement('div')
    const screen = document.createElement('div')
    screen.className = 'xterm-screen'
    box.appendChild(container)
    container.appendChild(screen)
    dimension(box, 'clientWidth', 800)
    dimension(box, 'clientHeight', 480)
    dimension(screen, 'offsetWidth', 800)
    dimension(screen, 'offsetHeight', 384)
    const claim = createPreviewGridClaim({
      ptyId: 'pty-1',
      container,
      getTerminal: () => ({ cols: 80, rows: 24 }) as never
    })

    claim.schedule()
    for (let step = 1; step <= 10; step += 1) {
      await vi.advanceTimersByTimeAsync(100)
      dimension(box, 'clientWidth', 800 + step * 20)
      claim.schedule()
    }

    expect(fit).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(200)
    expect(fit).toHaveBeenCalledTimes(1)
    expect(fit).toHaveBeenCalledWith('pty-1', 100, 30)
    claim.dispose()
  })
})
