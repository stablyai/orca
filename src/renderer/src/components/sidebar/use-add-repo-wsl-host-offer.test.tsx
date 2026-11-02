// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../../shared/execution-host'
import type { WslHostWindowsPathAccess } from '@/lib/windows-path-access'
import type * as WslHostOfferModule from './wsl-host-offer'
import { wslDistroWindowsPathAccess } from '../../../../shared/windows-path-access'

const hosts = vi.hoisted(() => ({
  saved: new Array<WslHostWindowsPathAccess>(),
  gateOpen: true
}))
vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ settings: null, runtimeEnvironments: [] }) }
}))
vi.mock('./wsl-host-offer', async (importOriginal) => {
  const actual = await importOriginal<typeof WslHostOfferModule>()
  return {
    ...actual,
    readExistingWslHosts: () => hosts.saved,
    readWslHostOfferGate: () => ({ gateOpen: hosts.gateOpen, settingOn: false, dismissed: false })
  }
})

import { useAddRepoWslHostOffer } from './use-add-repo-wsl-host-offer'

const HOST: ExecutionHostId = 'runtime:wsl-ubuntu'
const LOCAL: ExecutionHostId = LOCAL_EXECUTION_HOST_ID
const PATH = '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo'

function setup(selectable: boolean) {
  const selectHost = vi.fn(async () => selectable)
  const connectHost = vi.fn(async () => {})
  const addLocalPath = vi.fn(async () => {})
  const view = renderHook(
    ({ selectedHostId }: { selectedHostId: ExecutionHostId }) =>
      useAddRepoWslHostOffer(true, {
        selectedHostId,
        handleSelectAddProjectHost: selectHost,
        handleConnectAddProjectHost: connectHost
      }),
    { initialProps: { selectedHostId: LOCAL } }
  )
  const showNotice = () => render(<>{view.result.current.notice(addLocalPath)}</>)
  return { view, selectHost, connectHost, addLocalPath, showNotice }
}

describe('useAddRepoWslHostOffer', () => {
  beforeEach(() => {
    hosts.saved = [{ environmentId: 'wsl-ubuntu', access: wslDistroWindowsPathAccess('Ubuntu') }]
    hosts.gateOpen = true
  })
  afterEach(cleanup)

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

  it('Add on host selects the host and hands it the Linux path', async () => {
    const { view, showNotice, selectHost, connectHost } = setup(true)
    act(() => void view.result.current.offer(PATH, 'local_folder_picker'))
    showNotice()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Add on host' })))
    expect(selectHost).toHaveBeenCalledWith(HOST)
    expect(connectHost).not.toHaveBeenCalled()
    expect(view.result.current.hostPath).toEqual({ hostId: HOST, path: '/home/me/repo' })
  })

  it('Add on host starts a host that is not selectable yet', async () => {
    const { view, showNotice, connectHost } = setup(false)
    act(() => void view.result.current.offer(PATH, 'local_folder_picker'))
    showNotice()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Add on host' })))
    expect(connectHost).toHaveBeenCalledWith(HOST)
  })

  it('Add on this computer adds the Windows path as before', () => {
    const { view, showNotice, addLocalPath } = setup(true)
    act(() => void view.result.current.offer(PATH, 'local_folder_picker'))
    showNotice()
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Add on this computer' })))
    expect(addLocalPath).toHaveBeenCalledWith(PATH, 'local_folder_picker')
    expect(view.result.current.hostPath).toBeNull()
  })

  it('still offers to run a distro that is not a host yet', () => {
    hosts.saved = []
    const { view, showNotice } = setup(true)
    act(() => void view.result.current.offer(PATH, 'local_folder_picker'))
    showNotice()
    expect(screen.getByText('Run Ubuntu as a host (recommended)')).toBeTruthy()
  })

  it('holds nothing while another host is selected', () => {
    const { view } = setup(true)
    view.rerender({ selectedHostId: HOST })
    expect(view.result.current.offer(PATH, 'local_folder_picker')).toBe(false)
  })
})
