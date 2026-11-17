// @vitest-environment happy-dom

import { isValidElement } from 'react'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { PublicKnownRuntimeEnvironment } from '../../../../../../shared/remote-runtime/host-catalog/runtime-environments'
import { getDefaultSettings } from '../../../../../../shared/orca-profiles/constants'
import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host/execution-host'
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

  it('skips the offer when the drive path is already a saved project', async () => {
    setOfferState({
      repos: [
        {
          id: 'repo-w',
          path: 'W:\\home\\u\\repo',
          displayName: 'repo',
          badgeColor: '#000',
          addedAt: 1
        }
      ]
    })
    const { result } = renderOffer()
    let held = true
    await act(async () => {
      held = await result.current.offer('W:\\home\\u\\repo', 'local_folder_picker')
    })
    // Not held: the ordinary add finds the saved project instead of adding a UNC copy.
    expect(held).toBe(false)
    expect(result.current.notice(async () => undefined)).toBeNull()
  })

  it('shows no offer for an add closed or superseded while the drive resolved', async () => {
    setOfferState()
    let finish: (share: string | null) => void = () => {}
    resolveMappedDrivePath.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const { result } = renderOffer()
    let current = true
    let pending: Promise<boolean> = Promise.resolve(false)
    act(() => {
      pending = result.current.offer('W:\\home\\u\\old', 'local_folder_picker', () => current)
    })
    // Closed and reopened: the caller's generation moved on.
    current = false
    let held = false
    await act(async () => {
      finish('\\\\wsl.localhost\\Ubuntu\\home\\u\\old')
      held = await pending
    })
    expect(held).toBe(true)
    expect(result.current.notice(async () => undefined)).toBeNull()
  })

  it('lets a newer add win over a slower older lookup', async () => {
    setOfferState()
    let finishOld: (share: string | null) => void = () => {}
    resolveMappedDrivePath.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOld = resolve
        })
    )
    const { result } = renderOffer()
    let older: Promise<boolean> = Promise.resolve(false)
    act(() => {
      older = result.current.offer('W:\\home\\u\\old', 'local_folder_picker')
    })
    await act(async () => {
      await result.current.offer('W:\\home\\u\\new', 'local_folder_picker')
    })
    await act(async () => {
      finishOld('\\\\wsl.localhost\\Ubuntu\\home\\u\\old')
      await older
    })
    const notice = result.current.notice(async () => undefined)
    expect(isValidElement(notice) ? notice.key : null).toBe('W:\\home\\u\\new')
  })

  it('shows no offer once the selected host changed mid-lookup', async () => {
    setOfferState()
    let finish: (share: string | null) => void = () => {}
    resolveMappedDrivePath.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const { result, rerender } = renderHook(
      ({ hostId }: { hostId: ExecutionHostId }) =>
        useAddRepoWslHostOffer(
          true,
          {
            selectedHostId: hostId,
            handleSelectAddProjectHost: vi.fn(async () => true),
            handleConnectAddProjectHost: vi.fn(async () => true)
          },
          null
        ),
      { initialProps: { hostId: LOCAL_EXECUTION_HOST_ID } }
    )
    let pending: Promise<boolean> = Promise.resolve(false)
    act(() => {
      pending = result.current.offer('W:\\home\\u\\repo', 'local_folder_picker')
    })
    rerender({ hostId: 'runtime:other' })
    rerender({ hostId: LOCAL_EXECUTION_HOST_ID })
    let held = false
    await act(async () => {
      finish('\\\\wsl.localhost\\Ubuntu\\home\\u\\repo')
      held = await pending
    })
    expect(held).toBe(true)
    expect(result.current.notice(async () => undefined)).toBeNull()
  })
})
