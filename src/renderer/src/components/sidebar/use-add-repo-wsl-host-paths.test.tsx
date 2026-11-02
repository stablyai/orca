// @vitest-environment happy-dom
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExecutionHostId } from '../../../../shared/execution-host'

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
vi.mock('@/store', () => {
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
  it('offers the Windows folder picker only for a WSL host', () => {
    expect(setup({ selectedHostId: WSL_HOST }).view.result.current.browseWslHost).not.toBeNull()
    expect(
      setup({ selectedHostId: 'runtime:paired-server' }).view.result.current.browseWslHost
    ).toBeNull()
    expect(setup({ selectedHostId: 'local' }).view.result.current.browseWslHost).toBeNull()
  })

  it('offers nothing off Windows', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Macintosh)' })
    expect(setup({ selectedHostId: WSL_HOST }).view.result.current.browseWslHost).toBeNull()
  })

  it('fills the host path from a pick under the host distro', async () => {
    mocks.pickDirectory.mockResolvedValue('\\\\wsl.localhost\\ubuntu\\home\\me\\repo')
    const { view, setServerPath, setStep } = setup({ selectedHostId: WSL_HOST })
    act(() => view.result.current.browseWslHost?.())
    await waitFor(() => expect(setServerPath).toHaveBeenCalledWith('/home/me/repo'))
    expect(setStep).toHaveBeenCalledWith('server-path')
    expect(mocks.browse).toHaveBeenCalledWith('wsl:Ubuntu', '~')
    expect(mocks.pickDirectory).toHaveBeenCalledWith({
      defaultPath: '\\\\wsl.localhost\\Ubuntu\\home\\me'
    })
  })

  it.each([
    ['C:\\Users\\me\\src', 'C:\\Users\\me\\src'],
    ['\\\\wsl.localhost\\Ubuntu\\mnt\\c\\work', 'C:\\work']
  ])(
    'refuses a %s pick before it reaches the host path step or any scan',
    async (picked, windowsPath) => {
      mocks.pickDirectory.mockResolvedValue(picked)
      const { view, setServerPath, setStep, onWindowsDriveRefusal } = setup({
        selectedHostId: WSL_HOST
      })
      act(() => view.result.current.browseWslHost?.())
      await waitFor(() =>
        expect(onWindowsDriveRefusal).toHaveBeenCalledWith({
          kind: 'wsl_host_windows_drive_path',
          windowsPath
        })
      )
      // The host path step is what scans and adds; a refused pick never gets there.
      expect(setServerPath).not.toHaveBeenCalled()
      expect(setStep).not.toHaveBeenCalled()
    }
  )

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

  it('fills a dropped folder once its WSL host is selected', () => {
    const { view, setServerPath, setStep } = setup({ selectedHostId: null, dropped: '/home/me/a' })
    expect(setServerPath).not.toHaveBeenCalled()
    view.rerender({ selectedHostId: WSL_HOST, isOpen: true })
    expect(setServerPath).toHaveBeenCalledWith('/home/me/a')
    expect(setStep).toHaveBeenCalledWith('server-path')
    view.rerender({ selectedHostId: WSL_HOST, isOpen: true })
    expect(setServerPath).toHaveBeenCalledTimes(1)
  })
})
