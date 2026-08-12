import { afterEach, describe, expect, it, vi } from 'vitest'

function createReactHookHarness() {
  const refs: { current: unknown }[] = []
  const states: unknown[] = []
  const effects: { effect: () => void | (() => void); deps: readonly unknown[] | undefined }[] = []
  let refIndex = 0
  let stateIndex = 0

  return {
    beginRender: () => {
      refIndex = 0
      stateIndex = 0
      effects.length = 0
    },
    effects,
    react: {
      useCallback: <T extends (...args: never[]) => unknown>(callback: T): T => callback,
      useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
        effects.push({ effect, deps })
      },
      useRef: <T>(initialValue: T): { current: T } => {
        const index = refIndex
        refIndex += 1
        refs[index] ??= { current: initialValue }
        return refs[index] as { current: T }
      },
      useState: <T>(initialValue: T): [T, (value: T) => void] => {
        const index = stateIndex
        stateIndex += 1
        states[index] ??= initialValue
        return [
          states[index] as T,
          (value: T) => {
            states[index] = value
          }
        ]
      }
    }
  }
}

describe('useGrabMode', () => {
  afterEach(() => {
    vi.doUnmock('react')
    vi.doUnmock('@/hooks/useMountedRef')
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  it('uses the latest browser page when toggled before the page-change effect runs', async () => {
    const harness = createReactHookHarness()
    const setGrabMode = vi.fn(async () => ({ ok: true }))
    vi.doMock('react', () => harness.react)
    vi.doMock('@/hooks/useMountedRef', () => ({
      useMountedRef: () => ({ current: true })
    }))
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      api: {
        browser: {
          setGrabMode,
          awaitGrabSelection: vi.fn(() => new Promise(() => {})),
          cancelGrab: vi.fn()
        }
      }
    })
    const { useGrabMode } = await import('./useGrabMode')
    const render = (browserPageId: string) => {
      harness.beginRender()
      // oxlint-disable-next-line react-hooks/rules-of-hooks -- test harness mocks React's hook dispatcher directly.
      return useGrabMode(browserPageId)
    }

    render('page-1')
    harness.effects[0]?.effect()
    const grab = render('page-2')
    grab.toggle()
    await Promise.resolve()

    expect(setGrabMode).toHaveBeenCalledWith({
      browserPageId: 'page-2',
      enabled: true
    })
  })

  it('reports a picker injection failure without calling it a readiness error', async () => {
    const harness = createReactHookHarness()
    vi.doMock('react', () => harness.react)
    vi.doMock('@/hooks/useMountedRef', () => ({
      useMountedRef: () => ({ current: true })
    }))
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      api: {
        browser: {
          setGrabMode: vi.fn(async () => ({ ok: false, reason: 'injection-failed' })),
          awaitGrabSelection: vi.fn(),
          cancelGrab: vi.fn()
        }
      }
    })
    const { useGrabMode } = await import('./useGrabMode')
    const render = () => {
      harness.beginRender()
      // oxlint-disable-next-line react-hooks/rules-of-hooks -- test harness mocks React's hook dispatcher directly.
      return useGrabMode('page-1')
    }

    render().toggle()
    await Promise.resolve()

    const grab = render()
    expect(grab.state).toBe('error')
    expect(grab.error).toBe('Could not start element selection on this page.')
  })

  it('arms immediately and treats a second toggle as cancellation while enable is pending', async () => {
    const harness = createReactHookHarness()
    let resolveEnable!: (result: { ok: true }) => void
    const pendingEnable = new Promise<{ ok: true }>((resolve) => {
      resolveEnable = resolve
    })
    const setGrabMode = vi.fn(async ({ enabled }: { enabled: boolean }) =>
      enabled ? pendingEnable : ({ ok: true } as const)
    )
    const awaitGrabSelection = vi.fn(() => new Promise(() => {}))
    const cancelGrab = vi.fn()
    vi.doMock('react', () => harness.react)
    vi.doMock('@/hooks/useMountedRef', () => ({
      useMountedRef: () => ({ current: true })
    }))
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      api: {
        browser: { setGrabMode, awaitGrabSelection, cancelGrab }
      }
    })
    const { useGrabMode } = await import('./useGrabMode')
    const render = () => {
      harness.beginRender()
      // oxlint-disable-next-line react-hooks/rules-of-hooks -- test harness mocks React's hook dispatcher directly.
      return useGrabMode('page-1')
    }

    const grab = render()
    grab.toggle()
    expect(render().state).toBe('armed')

    grab.toggle()
    expect(setGrabMode.mock.calls.filter(([args]) => args.enabled)).toHaveLength(1)
    expect(render().state).toBe('idle')

    resolveEnable({ ok: true })
    await pendingEnable
    await Promise.resolve()

    expect(awaitGrabSelection).not.toHaveBeenCalled()
    await vi.waitFor(() => {
      expect(cancelGrab).toHaveBeenCalledWith({ browserPageId: 'page-1' })
    })
  })

  it('cancels the tab owning the grab when the page changes before effects run', async () => {
    const harness = createReactHookHarness()
    const setGrabMode = vi.fn(async () => ({ ok: true }))
    const awaitGrabSelection = vi.fn(() => new Promise(() => {}))
    const cancelGrab = vi.fn()
    vi.doMock('react', () => harness.react)
    vi.doMock('@/hooks/useMountedRef', () => ({
      useMountedRef: () => ({ current: true })
    }))
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      api: {
        browser: { setGrabMode, awaitGrabSelection, cancelGrab }
      }
    })
    const { useGrabMode } = await import('./useGrabMode')
    const render = (browserPageId: string) => {
      harness.beginRender()
      // oxlint-disable-next-line react-hooks/rules-of-hooks -- test harness mocks React's hook dispatcher directly.
      return useGrabMode(browserPageId)
    }

    render('page-1').toggle()
    await vi.waitFor(() => {
      expect(awaitGrabSelection).toHaveBeenCalledTimes(1)
    })

    render('page-2').cancel()

    expect(setGrabMode).toHaveBeenLastCalledWith({
      browserPageId: 'page-1',
      enabled: false
    })
    expect(cancelGrab).toHaveBeenCalledWith({ browserPageId: 'page-1' })
  })

  it('ignores a stale screenshot after restarting on the same page', async () => {
    const harness = createReactHookHarness()
    let resolveScreenshot!: (result: {
      ok: true
      screenshot: { dataUrl: string; width: number; height: number }
    }) => void
    const pendingScreenshot = new Promise<{
      ok: true
      screenshot: { dataUrl: string; width: number; height: number }
    }>((resolve) => {
      resolveScreenshot = resolve
    })
    const awaitGrabSelection = vi
      .fn()
      .mockResolvedValueOnce({
        kind: 'selected',
        payload: {
          target: {
            rectViewport: { x: 0, y: 0, width: 1, height: 1 }
          }
        }
      })
      .mockImplementation(() => new Promise(() => {}))
    const captureSelectionScreenshot = vi.fn(() => pendingScreenshot)
    vi.doMock('react', () => harness.react)
    vi.doMock('@/hooks/useMountedRef', () => ({
      useMountedRef: () => ({ current: true })
    }))
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      api: {
        browser: {
          setGrabMode: vi.fn(async () => ({ ok: true })),
          awaitGrabSelection,
          captureSelectionScreenshot,
          cancelGrab: vi.fn()
        }
      }
    })
    const { useGrabMode } = await import('./useGrabMode')
    const render = () => {
      harness.beginRender()
      // oxlint-disable-next-line react-hooks/rules-of-hooks -- test harness mocks React's hook dispatcher directly.
      return useGrabMode('page-1')
    }

    render().toggle()
    await vi.waitFor(() => {
      expect(captureSelectionScreenshot).toHaveBeenCalledTimes(1)
    })

    render().cancel()
    render().toggle()
    await vi.waitFor(() => {
      expect(awaitGrabSelection).toHaveBeenCalledTimes(2)
    })

    resolveScreenshot({
      ok: true,
      screenshot: { dataUrl: 'data:image/png;base64,AA==', width: 1, height: 1 }
    })
    await pendingScreenshot

    await vi.waitFor(() => {
      const grab = render()
      expect(grab.state).toBe('awaiting')
      expect(grab.payload).toBeNull()
    })
  })
})
