import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ReactModule from 'react'

const mocks = vi.hoisted(() => ({
  stateValues: [] as unknown[],
  stateSetters: [] as ReturnType<typeof vi.fn>[],
  stateIndex: 0,
  getDistroOptions: vi.fn()
}))

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>()
  return {
    ...actual,
    useCallback: <T extends (...args: never[]) => unknown>(fn: T) => fn,
    useEffect: (effect: () => void | (() => void)) => {
      effect()
    },
    useState: <T>(initial: T | (() => T)) => {
      const index = mocks.stateIndex++
      const value =
        index in mocks.stateValues
          ? mocks.stateValues[index]
          : typeof initial === 'function'
            ? (initial as () => T)()
            : initial
      const setter = vi.fn()
      mocks.stateSetters[index] = setter
      return [value as T, setter]
    }
  }
})

describe('useWslDistroOptions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.stateIndex = 0
    mocks.stateSetters = []
    mocks.stateValues = []
    vi.stubGlobal('window', {
      api: {
        wsl: {
          getDistroOptions: mocks.getDistroOptions
        }
      }
    })
  })

  it('loads distro options on mount without forcing a refresh', async () => {
    mocks.getDistroOptions.mockResolvedValue({
      available: true,
      distros: ['Ubuntu-24.04'],
      default: 'Ubuntu-24.04'
    })
    const { useWslDistroOptions } = await import('./use-wsl-distro-options')

    useWslDistroOptions()
    // The mocked useEffect runs the load synchronously; wait for the async body.
    await Promise.resolve()
    await Promise.resolve()

    expect(mocks.getDistroOptions).toHaveBeenCalledWith({ refresh: false })
  })

  it('reports unavailable/empty state when WSL is not installed', async () => {
    mocks.getDistroOptions.mockResolvedValue({ available: false, distros: [], default: null })
    const { useWslDistroOptions } = await import('./use-wsl-distro-options')

    useWslDistroOptions()
    await Promise.resolve()
    await Promise.resolve()

    // setOptions (the second useState setter) is called with the unavailable result.
    expect(mocks.stateSetters[0]).toHaveBeenCalledWith({
      available: false,
      distros: [],
      default: null
    })
  })

  it('re-queries with refresh: true when refresh() is invoked', async () => {
    mocks.getDistroOptions.mockResolvedValue({
      available: true,
      distros: ['Ubuntu-24.04'],
      default: 'Ubuntu-24.04'
    })
    const { useWslDistroOptions } = await import('./use-wsl-distro-options')

    const result = useWslDistroOptions()
    await Promise.resolve()
    await Promise.resolve()
    mocks.getDistroOptions.mockClear()

    await result.refresh()

    expect(mocks.getDistroOptions).toHaveBeenCalledWith({ refresh: true })
  })
})
