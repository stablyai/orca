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
})
