import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { PortForwardEntry } from '../../../../shared/ssh-types'
import type { WorkspacePort, WorkspacePortScanResult } from '../../../../shared/workspace-ports'
import { clearRuntimeCompatibilityCache as clearRuntimeCompatibilityCacheForTests } from '@/runtime/rpc/compatibility/runtime-compatibility-cache'
import {
  addressForPort,
  addressForPortForwardEntry,
  browserUrlForPort,
  browserUrlForPortForwardEntry
} from '@/lib/workspace-ports/workspace-port-urls'

const { activateAndRevealWorktreeMock } = vi.hoisted(() => ({
  activateAndRevealWorktreeMock: vi.fn()
}))

vi.mock('@/lib/workspace/activation/worktree-activation', () => ({
  activateAndRevealWorktree: activateAndRevealWorktreeMock
}))

import { getLocalWorkspacePortSections } from './local-workspace-port-sections'
import { mergeWorkspacePortScans } from '@/lib/workspace-ports/workspace-port-actions'

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
