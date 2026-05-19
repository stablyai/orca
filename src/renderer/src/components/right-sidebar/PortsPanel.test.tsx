import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../../../../shared/protocol-version'
import type { WorkspacePort, WorkspacePortScanResult } from '../../../../shared/workspace-ports'
import { clearRuntimeCompatibilityCacheForTests } from '@/runtime/runtime-rpc-client'

const { activateAndRevealWorktreeMock } = vi.hoisted(() => ({
  activateAndRevealWorktreeMock: vi.fn()
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: activateAndRevealWorktreeMock
}))

import {
  browserUrlForPort,
  killWorkspacePortForTarget,
  openWorkspacePortInBrowser,
  scanWorkspacePortsForTarget
} from './PortsPanel'

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

beforeEach(() => {
  localScan.mockReset()
  localKill.mockReset()
  runtimeCall.mockReset()
  runtimeEnvironmentCall.mockReset()
  activateAndRevealWorktreeMock.mockReset()
  clearRuntimeCompatibilityCacheForTests()
  vi.stubGlobal('window', {
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

  it('defaults unknown protocols to http for built-in browser opens', () => {
    expect(browserUrlForPort(workspacePort)).toBe('http://127.0.0.1:63468')
  })
})
