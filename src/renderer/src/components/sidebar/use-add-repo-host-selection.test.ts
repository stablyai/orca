import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ReactModule from 'react'
import type { SidebarHostOption } from './sidebar-host-options'

const mocks = vi.hoisted(() => ({
  stateValues: [] as unknown[],
  stateSetters: [] as ReturnType<typeof vi.fn>[],
  stateIndex: 0,
  refValues: [] as unknown[],
  refIndex: 0,
  hostOptions: [] as SidebarHostOption[],
  storeState: {
    settings: { activeRuntimeEnvironmentId: null as string | null },
    switchRuntimeEnvironment: vi.fn()
  }
}))

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>()
  return {
    ...actual,
    useCallback: <T extends (...args: never[]) => unknown>(fn: T) => fn,
    useEffect: (effect: () => void | (() => void)) => {
      effect()
    },
    useRef: <T>(value: T) => {
      const index = mocks.refIndex++
      return {
        current: index in mocks.refValues ? (mocks.refValues[index] as T) : value
      }
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

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: typeof mocks.storeState) => unknown) => selector(mocks.storeState)
}))

vi.mock('./use-sidebar-host-scope-options', () => ({
  useSidebarHostScopeOptions: () => ({ hostOptions: mocks.hostOptions })
}))

describe('useAddRepoHostSelection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.stateIndex = 0
    mocks.stateSetters = []
    mocks.refIndex = 0
    mocks.refValues = []
    mocks.hostOptions = [
      {
        id: 'local',
        label: 'Local Mac',
        detail: 'This computer',
        kind: 'local',
        health: 'local',
        presence: 'local'
      },
      {
        id: 'ssh:ssh-1',
        label: 'Builder',
        detail: 'SSH',
        kind: 'ssh',
        health: 'available',
        presence: 'configured'
      },
      {
        id: 'runtime:env-1',
        label: 'Server',
        detail: 'Runtime',
        kind: 'runtime',
        health: 'available',
        presence: 'active'
      }
    ]
    mocks.storeState.settings = { activeRuntimeEnvironmentId: null }
    mocks.storeState.switchRuntimeEnvironment.mockResolvedValue(true)
  })

  it('exposes the selected SSH target id', async () => {
    mocks.stateValues = ['ssh:ssh-1', false]
    const { useAddRepoHostSelection } = await import('./use-add-repo-host-selection')

    const result = useAddRepoHostSelection({ isOpen: true, setStep: vi.fn() })

    expect(result.selectedHostId).toBe('ssh:ssh-1')
    expect(result.selectedParsedHost).toMatchObject({ kind: 'ssh', targetId: 'ssh-1' })
    expect(result.selectedSshTargetId).toBe('ssh-1')
  })

  it('switches runtime before selecting a runtime host', async () => {
    mocks.stateValues = ['local', false]
    const setStep = vi.fn()
    const { useAddRepoHostSelection } = await import('./use-add-repo-host-selection')

    const result = useAddRepoHostSelection({ isOpen: true, setStep })
    await result.handleSelectAddProjectHost('runtime:env-1')

    expect(mocks.storeState.switchRuntimeEnvironment).toHaveBeenCalledWith('env-1')
    expect(mocks.stateSetters[0]).toHaveBeenCalledWith('runtime:env-1')
    expect(setStep).toHaveBeenCalledWith('add')
  })

  it('clears the active runtime before selecting a local or SSH host', async () => {
    mocks.stateValues = ['runtime:env-1', false]
    mocks.storeState.settings = { activeRuntimeEnvironmentId: 'env-1' }
    const setStep = vi.fn()
    const { useAddRepoHostSelection } = await import('./use-add-repo-host-selection')

    const result = useAddRepoHostSelection({ isOpen: true, setStep })
    await result.handleSelectAddProjectHost('ssh:ssh-1')

    expect(mocks.storeState.switchRuntimeEnvironment).toHaveBeenCalledWith(null)
    expect(mocks.stateSetters[0]).toHaveBeenCalledWith('ssh:ssh-1')
    expect(setStep).toHaveBeenCalledWith('add')
  })

  it('falls back from a disconnected selected SSH host to Local Mac', async () => {
    mocks.stateValues = ['ssh:ssh-1', false]
    mocks.hostOptions[1] = {
      ...mocks.hostOptions[1],
      health: 'disconnected'
    }
    const { useAddRepoHostSelection } = await import('./use-add-repo-host-selection')

    const result = useAddRepoHostSelection({ isOpen: true, setStep: vi.fn() })

    expect(result.selectedHostId).toBe('local')
    expect(result.selectedSshTargetId).toBeNull()
  })

  it('does not select a disconnected SSH host', async () => {
    mocks.stateValues = ['local', false]
    mocks.hostOptions[1] = {
      ...mocks.hostOptions[1],
      health: 'disconnected'
    }
    const setStep = vi.fn()
    const { useAddRepoHostSelection } = await import('./use-add-repo-host-selection')

    const result = useAddRepoHostSelection({ isOpen: true, setStep })
    await result.handleSelectAddProjectHost('ssh:ssh-1')

    expect(mocks.storeState.switchRuntimeEnvironment).not.toHaveBeenCalled()
    expect(mocks.stateSetters[0]).not.toHaveBeenCalledWith('ssh:ssh-1')
    expect(setStep).not.toHaveBeenCalled()
  })

  it('does not auto-select the active runtime host while it is unavailable', async () => {
    mocks.stateValues = ['local', false]
    mocks.hostOptions[2] = {
      ...mocks.hostOptions[2],
      health: 'blocked'
    }
    mocks.storeState.settings = { activeRuntimeEnvironmentId: 'env-1' }
    const { useAddRepoHostSelection } = await import('./use-add-repo-host-selection')

    useAddRepoHostSelection({ isOpen: true, setStep: vi.fn() })

    expect(mocks.stateSetters[0]).toHaveBeenCalledWith('local')
  })
})
