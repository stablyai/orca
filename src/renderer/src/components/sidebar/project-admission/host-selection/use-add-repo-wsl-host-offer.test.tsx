// @vitest-environment happy-dom

import { isValidElement } from 'react'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { PublicKnownRuntimeEnvironment } from '../../../../../../shared/remote-runtime/host-catalog/runtime-environments'
import { getDefaultSettings } from '../../../../../../shared/constants'
import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId
} from '../../../../../../shared/execution-host'
import { useAddRepoWslHostOffer } from './use-add-repo-wsl-host-offer'

const UBUNTU_HOST: PublicKnownRuntimeEnvironment = {
  id: 'wsl-ubuntu',
  name: 'Ubuntu',
  source: 'manual',
  createdAt: 1,
  updatedAt: 1,
  lastUsedAt: null,
  runtimeId: null,
  preferredEndpointId: 'default',
  endpoints: [],
  orcadDeployment: { kind: 'wsl', distro: 'Ubuntu', localPort: 4100, remotePort: 4200 }
}

const initialState = useAppStore.getState()
const originalApi = window.api
const resolveMappedDrivePath = vi.fn<(path: string) => Promise<string | null>>()

function setOfferState(overrides: Partial<ReturnType<typeof useAppStore.getState>> = {}): void {
  useAppStore.setState({
    settings: { ...getDefaultSettings('/home/test'), experimentalWslHosts: false },
    wslHostsAcceptNewWork: true,
    wslHostServerFiles: 'present',
    runtimeEnvironments: [],
    ...overrides
  })
}

function renderOffer() {
  return renderHook(() =>
    useAddRepoWslHostOffer(
      true,
      {
        selectedHostId: LOCAL_EXECUTION_HOST_ID,
        handleSelectAddProjectHost: vi.fn(async () => true),
        handleConnectAddProjectHost: vi.fn(async () => true)
      },
      null
    )
  )
}

beforeEach(() => {
  resolveMappedDrivePath.mockReset()
  resolveMappedDrivePath.mockImplementation(async (path) =>
    /^W:/i.test(path) ? path.replace(/^W:/i, '\\\\wsl.localhost\\Ubuntu') : null
  )
  vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('Windows')
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      ...originalApi,
      wsl: { ...originalApi?.wsl, resolveMappedDrivePath },
      runtimeEnvironments: { ...originalApi?.runtimeEnvironments, wslHosts: {} }
    }
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  Object.defineProperty(window, 'api', { configurable: true, value: originalApi })
  useAppStore.setState(initialState, true)
})

describe('useAddRepoWslHostOffer on a drive mapped to a distro share', () => {
  it('offers the distro as a host for a mapped-drive folder', async () => {
    setOfferState()
    const { result } = renderOffer()
    let held = false
    await act(async () => {
      held = await result.current.offer('W:\\home\\u\\repo', 'local_folder_picker')
    })
    expect(held).toBe(true)
    expect(resolveMappedDrivePath).toHaveBeenCalledWith('W:\\home\\u\\repo')
  })

  it('offers the saved host of the mapped distro with its Linux path', async () => {
    setOfferState({
      settings: { ...getDefaultSettings('/home/test'), experimentalWslHosts: true },
      runtimeEnvironments: [UBUNTU_HOST]
    })
    const select = vi.fn(async () => true)
    const { result } = renderHook(() =>
      useAddRepoWslHostOffer(
        true,
        {
          selectedHostId: LOCAL_EXECUTION_HOST_ID,
          handleSelectAddProjectHost: select,
          handleConnectAddProjectHost: vi.fn(async () => false)
        },
        null
      )
    )
    let held = false
    await act(async () => {
      held = await result.current.offer('W:\\home\\u\\repo', 'local_folder_picker')
    })
    expect(held).toBe(true)
    const notice = result.current.notice(async () => undefined)
    expect(isValidElement<{ distro: string; onAddOnHost: () => void }>(notice)).toBe(true)
    if (!isValidElement<{ distro: string; onAddOnHost: () => void }>(notice)) {
      return
    }
    expect(notice.props.distro).toBe('Ubuntu')
    await act(async () => {
      notice.props.onAddOnHost()
    })
    const hostId = toRuntimeExecutionHostId(UBUNTU_HOST.id)
    expect(select).toHaveBeenCalledWith(hostId)
    expect(result.current.hostPath).toEqual({ hostId, path: '/home/u/repo' })
  })

  it('adds an ordinary drive as before', async () => {
    setOfferState()
    const { result } = renderOffer()
    let held = true
    await act(async () => {
      held = await result.current.offer('C:\\src\\repo', 'local_folder_picker')
    })
    expect(held).toBe(false)
  })

  it('does not ask main when no offer could apply', async () => {
    setOfferState({ wslHostsAcceptNewWork: false })
    const { result } = renderOffer()
    let held = true
    await act(async () => {
      held = await result.current.offer('W:\\home\\u\\repo', 'local_folder_picker')
    })
    expect(held).toBe(false)
    expect(resolveMappedDrivePath).not.toHaveBeenCalled()
  })
})
