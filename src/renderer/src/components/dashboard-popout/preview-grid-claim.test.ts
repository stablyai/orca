// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPreviewGridClaim } from './preview-grid-claim'
import { buildPreviewFitHost, dimension } from './preview-fit-test-host'

describe('createPreviewGridClaim', () => {
  afterEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  it('waits for a resize signal instead of polling while layout is unmeasurable', async () => {
    vi.useFakeTimers()
    const fit = vi.fn(async () => ({ cols: 90, rows: 30 }))
    Object.assign(window, { api: { terminalPreview: { fit } } })
    const { container, box, screen } = buildPreviewFitHost()
    dimension(box, 'clientWidth', 900)
    dimension(box, 'clientHeight', 480)
    dimension(screen, 'offsetWidth', 0)
    dimension(screen, 'offsetHeight', 0)
    const claim = createPreviewGridClaim({
      ptyId: 'pty-1',
      surfaceId: 'surface-1',
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
    expect(fit).toHaveBeenCalledWith('pty-1', 90, 30, 'surface-1')
    claim.dispose()
  })

  it('coalesces a continuous resize burst into one settled fit request', async () => {
    vi.useFakeTimers()
    const fit = vi.fn(async (_ptyId: string, cols: number, rows: number) => ({ cols, rows }))
    Object.assign(window, { api: { terminalPreview: { fit } } })
    const { container, box, screen } = buildPreviewFitHost()
    dimension(box, 'clientWidth', 800)
    dimension(box, 'clientHeight', 480)
    dimension(screen, 'offsetWidth', 800)
    dimension(screen, 'offsetHeight', 384)
    const claim = createPreviewGridClaim({
      ptyId: 'pty-1',
      surfaceId: 'surface-1',
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
    expect(fit).toHaveBeenCalledWith('pty-1', 100, 30, 'surface-1')
    claim.dispose()
  })
  it('records the granted grid, not the requested one, when the runtime hands back a different size', async () => {
    vi.useFakeTimers()
    // Main clamps to the PTY's supported range and the viewer registry gives
    // the grid to whoever claimed last, so a request can succeed at another size.
    const fit = vi.fn(async () => ({ cols: 60, rows: 8 }))
    Object.assign(window, { api: { terminalPreview: { fit } } })
    const applied: ({ cols: number; rows: number } | null)[] = []
    const { container, box, screen } = buildPreviewFitHost()
    dimension(box, 'clientWidth', 900)
    dimension(box, 'clientHeight', 480)
    dimension(screen, 'offsetWidth', 800)
    dimension(screen, 'offsetHeight', 384)
    const claim = createPreviewGridClaim({
      ptyId: 'pty-1',
      surfaceId: 'surface-1',
      container,
      getTerminal: () => ({ cols: 80, rows: 24 }) as never,
      onApplied: (grid) => applied.push(grid)
    })

    claim.schedule()
    await vi.advanceTimersByTimeAsync(200)

    expect(fit).toHaveBeenCalledWith('pty-1', 90, 30, 'surface-1')
    expect(claim.getApplied()).toEqual({ cols: 60, rows: 8 })
    expect(applied).toEqual([{ cols: 60, rows: 8 }])

    // Re-asking cannot change a clamped or seized grant, so it is not repeated.
    claim.schedule()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(fit).toHaveBeenCalledTimes(1)
    claim.dispose()
  })

  it('reports a claim that did not land at all without retrying it', async () => {
    vi.useFakeTimers()
    const fit = vi.fn(async () => null)
    Object.assign(window, { api: { terminalPreview: { fit } } })
    const { container, box, screen } = buildPreviewFitHost()
    dimension(box, 'clientWidth', 900)
    dimension(box, 'clientHeight', 480)
    dimension(screen, 'offsetWidth', 800)
    dimension(screen, 'offsetHeight', 384)
    const claim = createPreviewGridClaim({
      ptyId: 'pty-1',
      surfaceId: 'surface-1',
      container,
      getTerminal: () => ({ cols: 80, rows: 24 }) as never
    })

    claim.schedule()
    await vi.advanceTimersByTimeAsync(200)
    expect(claim.getApplied()).toBeNull()

    claim.schedule()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(fit).toHaveBeenCalledTimes(1)
    claim.dispose()
  })

  it('settles at a fixed point once the terminal is resized to the granted grid', async () => {
    vi.useFakeTimers()
    const fit = vi.fn(async (_ptyId: string, cols: number, rows: number) => ({ cols, rows }))
    Object.assign(window, { api: { terminalPreview: { fit } } })
    const { container, box, screen } = buildPreviewFitHost()
    dimension(box, 'clientWidth', 900)
    dimension(box, 'clientHeight', 480)
    dimension(screen, 'offsetWidth', 800)
    dimension(screen, 'offsetHeight', 384)
    const grid = { cols: 80, rows: 24 }
    const claim = createPreviewGridClaim({
      ptyId: 'pty-1',
      surfaceId: 'surface-1',
      container,
      getTerminal: () => grid as never
    })

    claim.schedule()
    await vi.advanceTimersByTimeAsync(200)
    expect(fit).toHaveBeenCalledWith('pty-1', 90, 30, 'surface-1')

    // The claim resizes the PTY, main pushes a resync, and the reconnect
    // replays into a terminal resized to the granted grid — the frame now
    // fills the box at the same cell size. Re-measuring must land on the same
    // target, or claim -> resize -> resync -> claim never terminates.
    grid.cols = 90
    grid.rows = 30
    dimension(screen, 'offsetWidth', 900)
    dimension(screen, 'offsetHeight', 480)
    claim.schedule()
    await vi.advanceTimersByTimeAsync(1_000)

    expect(fit).toHaveBeenCalledTimes(1)
    claim.dispose()
  })

  it('re-issues a target that changed while a claim was in flight, once it settles', async () => {
    vi.useFakeTimers()
    let resolveFirst!: (grid: { cols: number; rows: number }) => void
    const fit = vi
      .fn(async (_ptyId: string, cols: number, rows: number) => ({ cols, rows }))
      .mockImplementationOnce(
        () =>
          new Promise<{ cols: number; rows: number }>((resolve) => {
            resolveFirst = resolve
          })
      )
    Object.assign(window, { api: { terminalPreview: { fit } } })
    const { container, box, screen } = buildPreviewFitHost()
    dimension(box, 'clientWidth', 900)
    dimension(box, 'clientHeight', 480)
    dimension(screen, 'offsetWidth', 800)
    dimension(screen, 'offsetHeight', 384)
    const claim = createPreviewGridClaim({
      ptyId: 'pty-1',
      surfaceId: 'surface-1',
      container,
      getTerminal: () => ({ cols: 80, rows: 24 }) as never
    })

    claim.schedule()
    await vi.advanceTimersByTimeAsync(200)
    expect(fit).toHaveBeenCalledWith('pty-1', 90, 30, 'surface-1')

    // The box grows while the IPC is out; that request used to be dropped for good.
    dimension(box, 'clientWidth', 1000)
    claim.schedule()
    await vi.advanceTimersByTimeAsync(200)
    expect(fit).toHaveBeenCalledTimes(1)

    resolveFirst({ cols: 90, rows: 30 })
    await vi.advanceTimersByTimeAsync(0)
    expect(fit).toHaveBeenCalledTimes(2)
    expect(fit).toHaveBeenLastCalledWith('pty-1', 100, 30, 'surface-1')

    await vi.advanceTimersByTimeAsync(1_000)
    expect(fit).toHaveBeenCalledTimes(2)
    claim.dispose()
  })

  it('does not follow up an in-flight claim whose target did not change', async () => {
    vi.useFakeTimers()
    let resolveFirst!: (grid: null) => void
    const fit = vi.fn(
      () =>
        new Promise<null>((resolve) => {
          resolveFirst = resolve
        })
    )
    Object.assign(window, { api: { terminalPreview: { fit } } })
    const { container, box, screen } = buildPreviewFitHost()
    dimension(box, 'clientWidth', 900)
    dimension(box, 'clientHeight', 480)
    dimension(screen, 'offsetWidth', 800)
    dimension(screen, 'offsetHeight', 384)
    const claim = createPreviewGridClaim({
      ptyId: 'pty-1',
      surfaceId: 'surface-1',
      container,
      getTerminal: () => ({ cols: 80, rows: 24 }) as never
    })

    claim.schedule()
    await vi.advanceTimersByTimeAsync(200)
    claim.schedule()
    await vi.advanceTimersByTimeAsync(200)
    expect(fit).toHaveBeenCalledTimes(1)

    resolveFirst(null)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(fit).toHaveBeenCalledTimes(1)
    claim.dispose()
  })

  it('adopts a grid a snapshot proved without re-asking, and re-asks when the box changes', async () => {
    vi.useFakeTimers()
    const fit = vi.fn(async (_ptyId: string, cols: number, rows: number) => ({ cols, rows }))
    Object.assign(window, { api: { terminalPreview: { fit } } })
    const { container, box, screen } = buildPreviewFitHost()
    dimension(box, 'clientWidth', 900)
    dimension(box, 'clientHeight', 480)
    dimension(screen, 'offsetWidth', 800)
    dimension(screen, 'offsetHeight', 384)
    const claim = createPreviewGridClaim({
      ptyId: 'pty-1',
      surfaceId: 'surface-1',
      container,
      getTerminal: () => ({ cols: 80, rows: 24 }) as never
    })

    claim.schedule()
    await vi.advanceTimersByTimeAsync(200)
    expect(claim.getApplied()).toEqual({ cols: 90, rows: 30 })

    // Another viewer resized the PTY: the snapshot is reality, not a lagging emulator.
    claim.noteAppliedFromSnapshot(120, 40)
    expect(claim.getApplied()).toEqual({ cols: 120, rows: 40 })
    expect(container.dataset.claimApplied).toBe('120x40')
    claim.schedule()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(fit).toHaveBeenCalledTimes(1)

    dimension(box, 'clientWidth', 1000)
    claim.schedule()
    await vi.advanceTimersByTimeAsync(200)
    expect(fit).toHaveBeenLastCalledWith('pty-1', 100, 30, 'surface-1')
    claim.dispose()
  })
})
