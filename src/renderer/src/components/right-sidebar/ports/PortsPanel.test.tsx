import { describe, expect, it } from 'vitest'

import type { PortForwardEntry } from '../../../../../shared/ssh-types'
import type { WorkspacePort, WorkspacePortScanResult } from '../../../../../shared/workspace-ports'
import {
  addressForPort,
  addressForPortForwardEntry,
  browserUrlForPort,
  browserUrlForPortForwardEntry
} from '@/lib/workspace-ports/workspace-port-urls'

import { getLocalWorkspacePortSections } from './local-workspace-port-sections'

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
