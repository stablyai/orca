import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../../../../shared/protocol-version'
import type { PortForwardEntry } from '../../../../shared/ssh-types'
import type { WorkspacePort, WorkspacePortScanResult } from '../../../../shared/workspace-ports'
import { clearRuntimeCompatibilityCacheForTests } from '@/runtime/runtime-rpc-client'
import {
  addressForPort,
  addressForPortForwardEntry,
  browserUrlForPort,
  browserUrlForPortForwardEntry
} from '@/lib/workspace-port-urls'

const { activateAndRevealWorktreeMock } = vi.hoisted(() => ({
  activateAndRevealWorktreeMock: vi.fn()
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: activateAndRevealWorktreeMock
}))

import { getLocalWorkspacePortSections } from './PortsPanel'
import {
  killWorkspacePortForTarget,
  mergeWorkspacePortScans,
  openWorkspacePortInBrowser,
  refreshWorkspacePortScanAfterStop,
  scanWorkspacePortsForTarget
} from '@/lib/workspace-port-actions'

const workspacePort: WorkspacePort = {
  id: '127.0.0.1:63468:1234',
  bindHost: '127.0.0.1',
  connectHost: '127.0.0.1',
  port: 63468,
  pid: 1234,
  processName: 'node',
  protocol: 'unknown',
  kind: 'workspace',
  owner: {
    worktreeId: 'repo::/workspace/app',
    repoId: 'repo',
    displayName: 'app',
    path: '/workspace/app',
    confidence: 'cwd'
  }
}

const emptyScan: WorkspacePortScanResult = {
  platform: process.platform,
  scannedAt: 1,
  ports: []
}

const compatibleStatus = {
  runtimeId: 'runtime-1',
  graphStatus: 'ready',
  runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
  minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION
}

const localScan = vi.fn()
const localKill = vi.fn()
const runtimeCall = vi.fn()
const runtimeEnvironmentCall = vi.fn()
const openUrl = vi.fn()

beforeEach(() => {
  localScan.mockReset()
  localKill.mockReset()
  runtimeCall.mockReset()
  runtimeEnvironmentCall.mockReset()
  openUrl.mockReset()
  activateAndRevealWorktreeMock.mockReset()
  clearRuntimeCompatibilityCacheForTests()
  vi.stubGlobal('window', {
    setTimeout: globalThis.setTimeout,
    api: {
      workspacePorts: {
        scan: localScan,
        kill: localKill
      },
      runtime: {
        call: runtimeCall
      },
      runtimeEnvironments: {
        call: runtimeEnvironmentCall
      },
      shell: {
        openUrl
      }
    }
  })
})

describe('PortsPanel runtime routing', () => {
  it('uses local IPC for local workspace port scans and kills', async () => {
    localScan.mockResolvedValueOnce(emptyScan)
    localKill.mockResolvedValueOnce({ ok: true })

    await expect(scanWorkspacePortsForTarget({ kind: 'local' }, 'repo')).resolves.toBe(emptyScan)
    await expect(
      killWorkspacePortForTarget({ kind: 'local' }, { repoId: 'repo', pid: 1234, port: 63468 })
    ).resolves.toEqual({ ok: true })

    expect(localScan).toHaveBeenCalledWith({ repoId: 'repo' })
    expect(localKill).toHaveBeenCalledWith({ repoId: 'repo', pid: 1234, port: 63468 })
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })

  it('coalesces concurrent local scans for the same runtime target and repo', async () => {
    let resolveScan: (scan: WorkspacePortScanResult) => void = () => {}
    localScan.mockReturnValueOnce(
      new Promise<WorkspacePortScanResult>((resolve) => {
        resolveScan = resolve
      })
    )

    const first = scanWorkspacePortsForTarget({ kind: 'local' }, 'repo')
    const second = scanWorkspacePortsForTarget({ kind: 'local' }, 'repo')

    expect(localScan).toHaveBeenCalledTimes(1)
    expect(localScan).toHaveBeenCalledWith({ repoId: 'repo' })

    resolveScan(emptyScan)
    await expect(Promise.all([first, second])).resolves.toEqual([emptyScan, emptyScan])
  })

  it('keeps separate scan keys for different repos', async () => {
    localScan.mockResolvedValue(emptyScan)

    await Promise.all([
      scanWorkspacePortsForTarget({ kind: 'local' }, 'repo-a'),
      scanWorkspacePortsForTarget({ kind: 'local' }, 'repo-b')
    ])

    expect(localScan).toHaveBeenCalledTimes(2)
    expect(localScan).toHaveBeenNthCalledWith(1, { repoId: 'repo-a' })
    expect(localScan).toHaveBeenNthCalledWith(2, { repoId: 'repo-b' })
  })

  it('keeps other repos visible as external when the panel consumes the shared scan', () => {
    const sameRepoOtherWorktree: WorkspacePort = {
      ...workspacePort,
      id: '127.0.0.1:5174:1235',
      port: 5174,
      pid: 1235,
      owner: {
        ...workspacePort.owner,
        worktreeId: 'repo::/workspace/other'
      }
    }
    const otherRepoWorkspace: WorkspacePort = {
      ...workspacePort,
      id: '127.0.0.1:5175:1236',
      port: 5175,
      pid: 1236,
      owner: {
        ...workspacePort.owner,
        repoId: 'other-repo',
        worktreeId: 'other-repo::/workspace/other-repo',
        displayName: 'other repo',
        path: '/workspace/other-repo'
      }
    }
    const unassignedPort: WorkspacePort = {
      id: '127.0.0.1:5176:1237',
      bindHost: '127.0.0.1',
      connectHost: '127.0.0.1',
      port: 5176,
      pid: 1237,
      processName: 'node',
      protocol: 'unknown',
      kind: 'external'
    }

    const sections = getLocalWorkspacePortSections(
      {
        ...emptyScan,
        ports: [workspacePort, sameRepoOtherWorktree, otherRepoWorkspace, unassignedPort]
      },
      'repo',
      'repo::/workspace/app'
    )

    expect(sections.activePorts.map((port) => port.port)).toEqual([63468])
    expect(sections.otherWorkspacePorts.map((port) => port.port)).toEqual([5174])
    expect(sections.externalPorts.map((port) => port.port)).toEqual([5175, 5176])
    expect(sections.externalPorts.map((port) => port.kind)).toEqual(['external', 'external'])
  })

  it('routes remote scans through runtime RPC and degrades on older runtimes', async () => {
    runtimeEnvironmentCall.mockImplementation(({ method }: { method: string }) =>
      Promise.resolve(
        method === 'status.get'
          ? { id: method, ok: true, result: compatibleStatus, _meta: { runtimeId: 'runtime-1' } }
          : {
              id: method,
              ok: false,
              error: { code: 'method_not_found', message: 'Unknown method' },
              _meta: { runtimeId: 'runtime-1' }
            }
      )
    )

    const result = await scanWorkspacePortsForTarget(
      { kind: 'environment', environmentId: 'env-1' },
      'repo'
    )

    expect(result).toMatchObject({
      ports: [],
      unavailableReason: 'The connected runtime does not support workspace port management yet.'
    })
    expect(runtimeEnvironmentCall.mock.calls.map((call) => call[0].method)).toEqual([
      'status.get',
      'workspacePorts.scan'
    ])
  })

  it('merges local and runtime scans with host-prefixed row ids', () => {
    const runtimePort: WorkspacePort = {
      ...workspacePort,
      id: workspacePort.id,
      port: 3000,
      owner: {
        ...workspacePort.owner,
        repoId: 'runtime-repo',
        worktreeId: 'runtime-repo::/srv/app',
        displayName: 'runtime app',
        path: '/srv/app'
      }
    }

    const merged = mergeWorkspacePortScans({
      'local:all': { ...emptyScan, scannedAt: 10, ports: [workspacePort] },
      'environment:env-1:all': { ...emptyScan, scannedAt: 20, ports: [runtimePort] }
    })

    expect(merged).toMatchObject({ platform: 'unknown', scannedAt: 20 })
    expect(merged?.ports.map((port) => port.id)).toEqual([
      `environment:env-1:all:${workspacePort.id}`,
      `local:all:${workspacePort.id}`
    ])
    expect(
      merged?.ports.map((port) => (port.kind === 'workspace' ? port.owner.worktreeId : null))
    ).toEqual(['runtime-repo::/srv/app', 'repo::/workspace/app'])
  })

  it('opens remote workspace ports in the server-side browser and binds the local page handle', async () => {
    runtimeEnvironmentCall.mockImplementation(({ method }: { method: string }) =>
      Promise.resolve({
        id: method,
        ok: true,
        result:
          method === 'status.get' ? compatibleStatus : { browserPageId: 'remote-browser-page-1' },
        _meta: { runtimeId: 'runtime-1' }
      })
    )
    const createBrowserTab = vi.fn(() => ({ activePageId: 'local-page-1' }))
    const setRemoteBrowserPageHandle = vi.fn()

    await expect(
      openWorkspacePortInBrowser({
        port: workspacePort,
        runtimeTarget: { kind: 'environment', environmentId: 'env-1' },
        createBrowserTab: createBrowserTab as never,
        setRemoteBrowserPageHandle: setRemoteBrowserPageHandle as never
      })
    ).resolves.toEqual({ ok: true })

    expect(activateAndRevealWorktreeMock).toHaveBeenCalledWith('repo::/workspace/app')
    expect(runtimeEnvironmentCall.mock.calls.map((call) => call[0].method)).toEqual([
      'status.get',
      'browser.tabCreate'
    ])
    expect(runtimeEnvironmentCall.mock.calls[1][0].params).toEqual({
      worktree: 'id:repo::/workspace/app',
      url: 'http://127.0.0.1:63468'
    })
    expect(createBrowserTab).toHaveBeenCalledWith(
      'repo::/workspace/app',
      'http://127.0.0.1:63468',
      {
        activate: true
      }
    )
    expect(setRemoteBrowserPageHandle).toHaveBeenCalledWith('local-page-1', {
      environmentId: 'env-1',
      remotePageId: 'remote-browser-page-1'
    })
  })

  it('opens workspace ports in the system browser when link routing is off', async () => {
    const createBrowserTab = vi.fn()
    const setRemoteBrowserPageHandle = vi.fn()
    openUrl.mockResolvedValueOnce(undefined)

    await expect(
      openWorkspacePortInBrowser({
        port: workspacePort,
        runtimeTarget: { kind: 'local' },
        createBrowserTab: createBrowserTab as never,
        setRemoteBrowserPageHandle: setRemoteBrowserPageHandle as never,
        openInOrcaBrowser: false
      })
    ).resolves.toEqual({ ok: true })

    expect(openUrl).toHaveBeenCalledWith('http://127.0.0.1:63468')
    expect(createBrowserTab).not.toHaveBeenCalled()
    expect(activateAndRevealWorktreeMock).not.toHaveBeenCalled()
  })

  it('returns post-stop refresh failures without throwing', async () => {
    const setWorkspacePortScan = vi.fn()
    const setWorkspacePortScanRefreshing = vi.fn()
    localScan.mockRejectedValueOnce(new Error('scan failed'))

    await expect(
      refreshWorkspacePortScanAfterStop({
        runtimeTarget: { kind: 'local' },
        setWorkspacePortScan: setWorkspacePortScan as never,
        setWorkspacePortScanRefreshing: setWorkspacePortScanRefreshing as never
      })
    ).resolves.toEqual({ ok: false, reason: 'scan failed' })

    expect(setWorkspacePortScan).not.toHaveBeenCalled()
    expect(setWorkspacePortScanRefreshing).toHaveBeenNthCalledWith(1, true)
    expect(setWorkspacePortScanRefreshing).toHaveBeenNthCalledWith(2, false)
  })

  it('ignores settled remote post-stop refresh failures after updating state', async () => {
    const setWorkspacePortScan = vi.fn()
    const setWorkspacePortScanRefreshing = vi.fn()
    const firstScan = { ...emptyScan, scannedAt: 2 }
    let scanCalls = 0
    runtimeEnvironmentCall.mockImplementation(({ method }: { method: string }) => {
      if (method === 'status.get') {
        return Promise.resolve({
          id: method,
          ok: true,
          result: compatibleStatus,
          _meta: { runtimeId: 'runtime-1' }
        })
      }
      if (method === 'workspacePorts.scan') {
        scanCalls += 1
        if (scanCalls === 1) {
          return Promise.resolve({
            id: method,
            ok: true,
            result: firstScan,
            _meta: { runtimeId: 'runtime-1' }
          })
        }
        return Promise.reject(new Error('transient RPC timeout'))
      }
      return Promise.reject(new Error(`Unexpected method ${method}`))
    })

    await expect(
      refreshWorkspacePortScanAfterStop({
        runtimeTarget: { kind: 'environment', environmentId: 'env-1' },
        setWorkspacePortScan: setWorkspacePortScan as never,
        setWorkspacePortScanRefreshing: setWorkspacePortScanRefreshing as never
      })
    ).resolves.toEqual({ ok: true })

    expect(runtimeEnvironmentCall.mock.calls.map((call) => call[0].method)).toEqual([
      'status.get',
      'workspacePorts.scan',
      'workspacePorts.scan'
    ])
    expect(setWorkspacePortScan).toHaveBeenCalledTimes(1)
    expect(setWorkspacePortScan).toHaveBeenCalledWith({
      key: 'environment:env-1:all',
      result: firstScan
    })
    expect(setWorkspacePortScanRefreshing).toHaveBeenNthCalledWith(1, true)
    expect(setWorkspacePortScanRefreshing).toHaveBeenNthCalledWith(2, false)
  })

  it('preserves an all-host projection after refreshing one host post-stop', async () => {
    const setWorkspacePortScan = vi.fn()
    const setWorkspacePortScanForKey = vi.fn()
    const setWorkspacePortScanRefreshing = vi.fn()
    const localPort: WorkspacePort = { ...workspacePort, id: 'local-port', port: 5173 }
    const refreshedRemotePort: WorkspacePort = {
      ...workspacePort,
      id: 'remote-port',
      port: 3000,
      owner: {
        ...workspacePort.owner,
        repoId: 'runtime-repo',
        worktreeId: 'runtime-repo::/srv/app',
        displayName: 'runtime app',
        path: '/srv/app'
      }
    }
    const localHostScan: WorkspacePortScanResult = {
      ...emptyScan,
      scannedAt: 10,
      ports: [localPort]
    }
    const remoteHostScan: WorkspacePortScanResult = {
      ...emptyScan,
      scannedAt: 20,
      ports: [refreshedRemotePort]
    }
    let scanCalls = 0
    runtimeEnvironmentCall.mockImplementation(({ method }: { method: string }) => {
      if (method === 'status.get') {
        return Promise.resolve({
          id: method,
          ok: true,
          result: compatibleStatus,
          _meta: { runtimeId: 'runtime-1' }
        })
      }
      if (method === 'workspacePorts.scan') {
        scanCalls += 1
        return Promise.resolve({
          id: method,
          ok: true,
          result: remoteHostScan,
          _meta: { runtimeId: 'runtime-1' }
        })
      }
      return Promise.reject(new Error(`Unexpected method ${method}`))
    })

    await expect(
      refreshWorkspacePortScanAfterStop({
        runtimeTarget: { kind: 'environment', environmentId: 'env-1' },
        setWorkspacePortScan: setWorkspacePortScan as never,
        setWorkspacePortScanForKey: setWorkspacePortScanForKey as never,
        getWorkspacePortScansByKey: () => ({ 'local:all': localHostScan }),
        setWorkspacePortScanRefreshing: setWorkspacePortScanRefreshing as never
      })
    ).resolves.toEqual({ ok: true })

    expect(setWorkspacePortScanForKey).toHaveBeenCalledWith('environment:env-1:all', remoteHostScan)
    expect(setWorkspacePortScan).toHaveBeenLastCalledWith({
      key: 'all-hosts:all',
      result: expect.objectContaining({
        ports: expect.arrayContaining([
          expect.objectContaining({ port: 5173 }),
          expect.objectContaining({ port: 3000 })
        ])
      })
    })
    expect(scanCalls).toBe(2)
  })

  it('keeps remote workspace ports in the server-side browser when link routing is off', async () => {
    runtimeEnvironmentCall.mockImplementation(({ method }: { method: string }) =>
      Promise.resolve({
        id: method,
        ok: true,
        result:
          method === 'status.get' ? compatibleStatus : { browserPageId: 'remote-browser-page-1' },
        _meta: { runtimeId: 'runtime-1' }
      })
    )
    const createBrowserTab = vi.fn(() => ({ activePageId: 'local-page-1' }))
    const setRemoteBrowserPageHandle = vi.fn()

    await expect(
      openWorkspacePortInBrowser({
        port: workspacePort,
        runtimeTarget: { kind: 'environment', environmentId: 'env-1' },
        createBrowserTab: createBrowserTab as never,
        setRemoteBrowserPageHandle: setRemoteBrowserPageHandle as never,
        openInOrcaBrowser: false
      })
    ).resolves.toEqual({ ok: true })

    expect(openUrl).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall.mock.calls.map((call) => call[0].method)).toEqual([
      'status.get',
      'browser.tabCreate'
    ])
    expect(createBrowserTab).toHaveBeenCalledWith(
      'repo::/workspace/app',
      'http://127.0.0.1:63468',
      { activate: true }
    )
    expect(setRemoteBrowserPageHandle).toHaveBeenCalledWith('local-page-1', {
      environmentId: 'env-1',
      remotePageId: 'remote-browser-page-1'
    })
  })

  it('defaults unknown protocols to http for built-in browser opens', () => {
    expect(browserUrlForPort(workspacePort)).toBe('http://127.0.0.1:63468')
  })

  it('prefers advertisedUrl over the OS-derived host:port', () => {
    const advertised: WorkspacePort = {
      ...workspacePort,
      advertisedUrl: 'https://local.getmontecarlo.com:63468'
    }
    expect(browserUrlForPort(advertised)).toBe('https://local.getmontecarlo.com:63468')
    expect(addressForPort(advertised)).toBe('local.getmontecarlo.com:63468')
  })

  it('formats SSH forwarded advertised URLs with a single protocol fallback order', () => {
    const forward: PortForwardEntry = {
      id: 'forward-1',
      connectionId: 'connection-1',
      localPort: 63468,
      remoteHost: 'localhost',
      remotePort: 3001,
      advertisedUrl: 'https://local.getmontecarlo.com:3001'
    }

    expect(browserUrlForPortForwardEntry(forward)).toBe('https://local.getmontecarlo.com:63468')
    expect(addressForPortForwardEntry(forward)).toBe('local.getmontecarlo.com:63468')
    expect(browserUrlForPortForwardEntry({ ...forward, advertisedProtocol: 'http' })).toBe(
      'http://local.getmontecarlo.com:63468'
    )
    expect(
      browserUrlForPortForwardEntry({
        ...forward,
        advertisedUrl: undefined,
        remotePort: 8443
      })
    ).toBe('https://127.0.0.1:63468')
    expect(addressForPortForwardEntry({ ...forward, advertisedUrl: undefined })).toBe(
      '127.0.0.1:63468'
    )
  })
})
