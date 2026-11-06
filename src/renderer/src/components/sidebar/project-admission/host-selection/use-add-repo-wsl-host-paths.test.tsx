// @vitest-environment happy-dom
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'

const mocks = vi.hoisted(() => ({
  state: {
    runtimeEnvironments: [
      {
        id: 'wsl:Ubuntu',
        orcadDeployment: {
          kind: 'wsl' as const,
          distro: 'Ubuntu',
          localPort: 4100,
          remotePort: 4200
        }
      },
      { id: 'paired-server' }
    ]
  },
  browse: vi.fn(),
  pickDirectory: vi.fn()
}))
vi.mock('@/store/index', () => {
  const useAppStore = (selector: (state: typeof mocks.state) => unknown): unknown =>
    selector(mocks.state)
  useAppStore.getState = () => mocks.state
  return { useAppStore }
})
vi.mock('@/runtime/runtime-server-directory-browser', () => ({
  browseRuntimeServerDirectory: mocks.browse
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

import { useAddRepoWslHostPaths } from './use-add-repo-wsl-host-paths'

const WSL_HOST: ExecutionHostId = 'runtime:wsl%3AUbuntu'

function setup(initial: { selectedHostId: ExecutionHostId | null; dropped?: string }) {
  const setServerPath = vi.fn()
  const setStep = vi.fn()
  const onWindowsDriveRefusal = vi.fn()
  const droppedHostPath = initial.dropped ? { hostId: WSL_HOST, path: initial.dropped } : null
  const view = renderHook(
    ({ selectedHostId, isOpen }: { selectedHostId: ExecutionHostId | null; isOpen: boolean }) =>
      useAddRepoWslHostPaths({
        isOpen,
        droppedHostPath,
        selectedHostId,
        setServerPath,
        setStep,
        onWindowsDriveRefusal
      }),
    { initialProps: { selectedHostId: initial.selectedHostId, isOpen: true } }
  )
  return { view, setServerPath, setStep, onWindowsDriveRefusal }
}

beforeEach(() => {
  vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' })
  vi.stubGlobal('api', { shell: { pickDirectory: mocks.pickDirectory } })
  mocks.browse.mockResolvedValue({ resolvedPath: '/home/me', entries: [] })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('useAddRepoWslHostPaths', () => {
  it('drops a pick that lands after the dialog closed', async () => {
    let resolvePick: (path: string) => void = () => {}
    mocks.pickDirectory.mockReturnValue(new Promise((resolve) => (resolvePick = resolve)))
    const { view, setServerPath } = setup({ selectedHostId: WSL_HOST })
    act(() => view.result.current.browseWslHost?.())
    await waitFor(() => expect(mocks.pickDirectory).toHaveBeenCalled())
    view.rerender({ selectedHostId: WSL_HOST, isOpen: false })
    await act(async () => resolvePick('\\\\wsl.localhost\\Ubuntu\\home\\me\\repo'))
    expect(setServerPath).not.toHaveBeenCalled()
  })
})
