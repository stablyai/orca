import { describe, expect, it } from 'vitest'
import type { WorkspacePort, WorkspacePortScanResult } from '../../../shared/workspace-ports'
import {
  getExternalWorkspacePorts,
  getWorkspacePortGroups,
  getWorkspacePortsByWorktreeId
} from './workspace-port-groups'

function workspacePort(worktreeId: string, displayName: string, port: number): WorkspacePort {
  return {
    id: `${worktreeId}:${port}`,
    bindHost: '127.0.0.1',
    connectHost: '127.0.0.1',
    port,
    protocol: 'http',
    kind: 'workspace',
    owner: { worktreeId, repoId: 'repo', displayName, path: `/${worktreeId}`, confidence: 'cwd' }
  }
}

function scan(ports: WorkspacePort[]): WorkspacePortScanResult {
  return { platform: 'linux', scannedAt: 0, ports }
}

describe('workspace port group caches', () => {
  it('returns stable empty references when no scan result exists', () => {
    expect(getWorkspacePortsByWorktreeId(null)).toBe(getWorkspacePortsByWorktreeId(undefined))
    expect(getWorkspacePortGroups(null)).toBe(getWorkspacePortGroups(undefined))
    expect(getExternalWorkspacePorts(null)).toBe(getExternalWorkspacePorts(undefined))
  })

  it('sorts groups with an undefined owner displayName without throwing (crash 99657ab1)', () => {
    // owner.displayName copies Worktree.displayName, which arrives undefined at runtime.
    const result = scan([
      workspacePort('named', 'Beta', 3000),
      workspacePort('unnamed', undefined as unknown as string, 3001)
    ])

    expect(() => getWorkspacePortGroups(result)).not.toThrow()
    // Undefined coalesces to '' which sorts before a real name.
    expect(getWorkspacePortGroups(result).map((group) => group.worktreeId)).toEqual([
      'unnamed',
      'named'
    ])
  })
})
