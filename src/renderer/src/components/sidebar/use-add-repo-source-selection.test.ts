import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ReactModule from 'react'

const mocks = vi.hoisted(() => ({
  stateValues: [] as unknown[],
  stateSetters: [] as ReturnType<typeof vi.fn>[],
  stateIndex: 0,
  refValues: [] as unknown[],
  refIndex: 0,
  hostSelection: {
    hostOptions: [],
    selectedHostId: 'local',
    selectedParsedHost: { kind: 'local' } as { kind: string; targetId?: string },
    selectedSshTargetId: null,
    hostSelectorOpen: false,
    setHostSelectorOpen: vi.fn(),
    handleSelectAddProjectHost: vi.fn(),
    handleConnectAddProjectHost: vi.fn()
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

vi.mock('./use-add-repo-host-selection', () => ({
  useAddRepoHostSelection: () => mocks.hostSelection
}))

const resetWslFlowMock = vi.fn()

describe('useAddRepoSourceSelection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.stateIndex = 0
    mocks.stateSetters = []
    mocks.stateValues = []
    mocks.refIndex = 0
    mocks.refValues = []
    mocks.hostSelection.selectedParsedHost = { kind: 'local' }
    mocks.hostSelection.handleSelectAddProjectHost.mockResolvedValue(undefined)
    mocks.hostSelection.handleConnectAddProjectHost.mockResolvedValue(undefined)
  })

  it('defaults selectedSource to local and never auto-selects wsl on open', async () => {
    mocks.stateValues = [false]
    mocks.refValues = [false]
    const { useAddRepoSourceSelection } = await import('./use-add-repo-source-selection')

    const result = useAddRepoSourceSelection({
      isOpen: true,
      setStep: vi.fn(),
      resetWslFlow: resetWslFlowMock
    })

    expect(result.selectedSource).toEqual({ kind: 'local' })
  })

  it('derives an ssh selectedSource from the underlying host selection', async () => {
    mocks.stateValues = [false]
    mocks.refValues = [true]
    mocks.hostSelection.selectedParsedHost = { kind: 'ssh', targetId: 'ssh-1' }
    const { useAddRepoSourceSelection } = await import('./use-add-repo-source-selection')

    const result = useAddRepoSourceSelection({
      isOpen: true,
      setStep: vi.fn(),
      resetWslFlow: resetWslFlowMock
    })

    expect(result.selectedSource).toEqual({ kind: 'ssh', targetId: 'ssh-1' })
  })

  it('selectWslSource switches selectedSource to wsl and navigates to the wsl step', async () => {
    mocks.stateValues = [false]
    mocks.refValues = [true]
    const setStep = vi.fn()
    const { useAddRepoSourceSelection } = await import('./use-add-repo-source-selection')

    const result = useAddRepoSourceSelection({
      isOpen: true,
      setStep,
      resetWslFlow: resetWslFlowMock
    })
    result.selectWslSource()

    expect(mocks.stateSetters[0]).toHaveBeenCalledWith(true)
    expect(setStep).toHaveBeenCalledWith('wsl')
  })

  it('resets wsl selection on the open transition (never auto-selects wsl)', async () => {
    mocks.stateValues = [true]
    mocks.refValues = [false]
    const { useAddRepoSourceSelection } = await import('./use-add-repo-source-selection')

    useAddRepoSourceSelection({ isOpen: true, setStep: vi.fn(), resetWslFlow: resetWslFlowMock })

    expect(mocks.stateSetters[0]).toHaveBeenCalledWith(false)
  })

  it('does not reset wsl selection while the dialog stays open', async () => {
    mocks.stateValues = [true]
    mocks.refValues = [true]
    const { useAddRepoSourceSelection } = await import('./use-add-repo-source-selection')

    useAddRepoSourceSelection({ isOpen: true, setStep: vi.fn(), resetWslFlow: resetWslFlowMock })

    expect(mocks.stateSetters[0]).not.toHaveBeenCalled()
  })

  it('clears wsl selection after selecting a normal host', async () => {
    mocks.stateValues = [true]
    mocks.refValues = [true]
    const { useAddRepoSourceSelection } = await import('./use-add-repo-source-selection')

    const result = useAddRepoSourceSelection({
      isOpen: true,
      setStep: vi.fn(),
      resetWslFlow: resetWslFlowMock
    })
    await result.handleSelectAddProjectHost('local' as never)

    expect(mocks.hostSelection.handleSelectAddProjectHost).toHaveBeenCalledWith('local')
    expect(mocks.stateSetters[0]).toHaveBeenCalledWith(false)
    // Why: host-scoped resets skip a same-host re-selection, so the WSL fields
    // (distro/path/error) must be cleared here or a later WSL visit is stale.
    expect(resetWslFlowMock).toHaveBeenCalled()
  })

  it('clears wsl selection after connecting a host', async () => {
    mocks.stateValues = [true]
    mocks.refValues = [true]
    const { useAddRepoSourceSelection } = await import('./use-add-repo-source-selection')

    const result = useAddRepoSourceSelection({
      isOpen: true,
      setStep: vi.fn(),
      resetWslFlow: resetWslFlowMock
    })
    await result.handleConnectAddProjectHost('ssh:ssh-1' as never)

    expect(mocks.hostSelection.handleConnectAddProjectHost).toHaveBeenCalledWith('ssh:ssh-1')
    expect(mocks.stateSetters[0]).toHaveBeenCalledWith(false)
    expect(resetWslFlowMock).toHaveBeenCalled()
  })

  it('clears the WSL flow when re-selecting the same host', async () => {
    // Why: selectedHostId does not change on a same-host re-selection, so the
    // host-change reset never fires; the source hook must clear the WSL fields.
    mocks.stateValues = [false]
    mocks.refValues = [true]
    const { useAddRepoSourceSelection } = await import('./use-add-repo-source-selection')

    const result = useAddRepoSourceSelection({
      isOpen: true,
      setStep: vi.fn(),
      resetWslFlow: resetWslFlowMock
    })
    await result.handleSelectAddProjectHost('local' as never)

    expect(resetWslFlowMock).toHaveBeenCalledTimes(1)
  })
})
