// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { getDefaultSettings } from '../../../../../../shared/orca-profiles/constants'
import type { PublicKnownRuntimeEnvironment } from '../../../../../../shared/remote-runtime/host-catalog/runtime-environments'
import { routeDroppedPath } from './useSidebarProjectDrop'

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

beforeEach(() => {
  resolveMappedDrivePath.mockReset()
  resolveMappedDrivePath.mockImplementation(async (path) =>
    /^W:/i.test(path) ? path.replace(/^W:/i, '\\\\wsl.localhost\\Ubuntu') : null
  )
  vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('Windows')
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { ...originalApi, wsl: { ...originalApi?.wsl, resolveMappedDrivePath } }
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  Object.defineProperty(window, 'api', { configurable: true, value: originalApi })
  useAppStore.setState(initialState, true)
})

describe('routeDroppedPath', () => {
  it('routes a drop on a drive mapped to a host distro to that host', async () => {
    useAppStore.setState({
      settings: { ...getDefaultSettings('/home/test'), experimentalWslHosts: true },
      runtimeEnvironments: [UBUNTU_HOST]
    })
    await expect(routeDroppedPath('W:\\home\\u\\repo')).resolves.toEqual({
      kind: 'wsl-host',
      hostId: 'runtime:wsl-ubuntu',
      linuxPath: '/home/u/repo'
    })
  })

  it('keeps an ordinary drive local, and skips the lookup with no WSL host', async () => {
    useAppStore.setState({
      settings: { ...getDefaultSettings('/home/test'), experimentalWslHosts: true },
      runtimeEnvironments: [UBUNTU_HOST]
    })
    await expect(routeDroppedPath('C:\\src\\repo')).resolves.toEqual({
      kind: 'local',
      path: 'C:\\src\\repo'
    })
    useAppStore.setState({ runtimeEnvironments: [] })
    resolveMappedDrivePath.mockClear()
    await expect(routeDroppedPath('W:\\home\\u\\repo')).resolves.toEqual({
      kind: 'local',
      path: 'W:\\home\\u\\repo'
    })
    expect(resolveMappedDrivePath).not.toHaveBeenCalled()
  })
})
