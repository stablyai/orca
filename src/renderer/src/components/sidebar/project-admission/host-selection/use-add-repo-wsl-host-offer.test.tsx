// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import type * as WslHostOfferModule from '../../wsl-host-offer'
import type { DroppedHostPath } from './add-repo-wsl-host-folder-picker'

const UBUNTU_HOST = {
  id: 'wsl-ubuntu',
  orcadDeployment: { kind: 'wsl' as const, distro: 'Ubuntu', localPort: 4100, remotePort: 4200 }
}
const mocks = vi.hoisted(() => ({
  gateOpen: true,
  state: {
    settings: { experimentalWslHosts: true },
    runtimeEnvironments: new Array<{
      id: string
      orcadDeployment: { kind: 'wsl'; distro: string; localPort: number; remotePort: number }
    }>()
  }
}))
vi.mock('@/store/index', () => {
  const useAppStore = (selector: (state: typeof mocks.state) => unknown): unknown =>
    selector(mocks.state)
  useAppStore.getState = () => mocks.state
  return { useAppStore }
})
vi.mock('@/runtime/files/reads/runtime-server-directory-browser', () => ({
  browseRuntimeServerDirectory: vi.fn()
}))
// Only the run-as-host gate is faked; saved hosts come from the store state above.
vi.mock('../../wsl-host-offer', async (importOriginal) => {
  const actual = await importOriginal<typeof WslHostOfferModule>()
  return {
    ...actual,
    readWslHostOfferGate: () => ({ gateOpen: mocks.gateOpen, settingOn: false, dismissed: false })
  }
})

import { useAddRepoWslHostOffer } from './use-add-repo-wsl-host-offer'
import { useAddRepoWslHostPaths } from './use-add-repo-wsl-host-paths'

const HOST: ExecutionHostId = 'runtime:wsl-ubuntu'
const LOCAL: ExecutionHostId = LOCAL_EXECUTION_HOST_ID
const PATH = '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo'

type HookProps = { selectedHostId: ExecutionHostId; droppedHostPath?: DroppedHostPath | null }

function setup(selectable: boolean, connects = true) {
  const initialProps: HookProps = { selectedHostId: LOCAL }
  const selectHost = vi.fn(async () => selectable)
  const connectHost = vi.fn(async () => connects)
  const addLocalPath = vi.fn(async () => {})
  const setServerPath = vi.fn()
  const setStep = vi.fn()
  // Wired as AddRepoDialog wires them: the offer's host path feeds the host-path prefill.
  const view = renderHook(
    ({ selectedHostId, droppedHostPath = null }: HookProps) => {
      const offer = useAddRepoWslHostOffer(
        true,
        {
          selectedHostId,
          handleSelectAddProjectHost: selectHost,
          handleConnectAddProjectHost: connectHost
        },
        droppedHostPath
      )
      useAddRepoWslHostPaths({
        isOpen: true,
        droppedHostPath: offer.hostPath,
        selectedHostId,
        setServerPath,
        setStep,
        onWindowsDriveRefusal: vi.fn()
      })
      return offer
    },
    { initialProps }
  )
  const showNotice = () => render(<>{view.result.current.notice(addLocalPath)}</>)
  const clickAddOnHost = () =>
    act(async () => fireEvent.click(screen.getByRole('button', { name: 'Add on host' })))
  return { view, selectHost, connectHost, addLocalPath, setServerPath, showNotice, clickAddOnHost }
}

describe('useAddRepoWslHostOffer', () => {
  beforeEach(() => {
    mocks.gateOpen = true
    mocks.state.settings = { experimentalWslHosts: true }
    mocks.state.runtimeEnvironments = [UBUNTU_HOST]
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' })
    vi.stubGlobal('api', { runtimeEnvironments: { wslHosts: {} } })
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('offers the existing host instead of adding the distro path on Windows', () => {
    const { view, showNotice, addLocalPath } = setup(true)
    let held = false
    act(() => {
      held = view.result.current.offer(PATH, 'local_folder_picker')
    })
    expect(held).toBe(true)
    showNotice()
    expect(screen.getByText('Add on the Ubuntu host (recommended)')).toBeTruthy()
    expect(screen.queryByText('Run Ubuntu as a host (recommended)')).toBeNull()
    expect(addLocalPath).not.toHaveBeenCalled()
  })

  it('keeps the offer when the host fails to start, so the user can still add it here', async () => {
    const { view, showNotice, addLocalPath, clickAddOnHost } = setup(false, false)
    act(() => void view.result.current.offer(PATH, 'local_folder_picker'))
    showNotice()
    await clickAddOnHost()
    expect(view.result.current.hostPath).toBeNull()
    cleanup()
    showNotice()
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Add on this computer' })))
    expect(addLocalPath).toHaveBeenCalledWith(PATH, 'local_folder_picker')
  })

  it('holds nothing while another host is selected', () => {
    const { view } = setup(true)
    view.rerender({ selectedHostId: HOST })
    expect(view.result.current.offer(PATH, 'local_folder_picker')).toBe(false)
  })
})
