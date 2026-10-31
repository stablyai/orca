import { describe, expect, it } from 'vitest'
import {
  matchingWorkspaceServerPort,
  parseWorkspaceServerLaunches,
  workspaceServerLaunchKey,
  type WorkspaceServerLaunch
} from './workspace-server-launches'
import type { WorkspacePortScanResult } from '../../../shared/workspace-ports'

const entry: WorkspaceServerLaunch = {
  id: workspaceServerLaunchKey({ kind: 'local' }, 'local', 'wt', 4008),
  runtimeTarget: { kind: 'local' },
  executionHostId: 'local',
  worktreeId: 'wt',
  repoId: 'repo',
  name: 'Frontend',
  port: 4008,
  command: 'pnpm dev --port 4008',
  cwd: '/repo/frontend',
  workspacePath: '/repo'
}

describe('saved server commands', () => {
  it('restores validated commands, rejecting corrupted or mismatched execution targets', () => {
    expect(parseWorkspaceServerLaunches([entry])).toEqual([entry])
    expect(
      parseWorkspaceServerLaunches([
        null,
        { ...entry, port: -1 },
        { ...entry, command: ' ' },
        { ...entry, runtimeTarget: { kind: 'environment' } },
        { ...entry, worktreeId: 'other' }
      ])
    ).toEqual([])
  })
  it('keeps runtime, host and workspace identities separate even for the same port', () => {
    expect(
      workspaceServerLaunchKey({ kind: 'environment', environmentId: 'host' }, 'local', 'wt', 4008)
    ).not.toBe(entry.id)
    expect(workspaceServerLaunchKey({ kind: 'local' }, 'ssh:host', 'wt', 4008)).not.toBe(entry.id)
    expect(workspaceServerLaunchKey({ kind: 'local' }, 'local', 'other', 4008)).not.toBe(entry.id)
  })
  it('treats a port owned elsewhere as a conflict rather than a running saved server', () => {
    const port = {
      id: 'listener',
      kind: 'workspace' as const,
      bindHost: '127.0.0.1',
      connectHost: 'localhost',
      port: 4008,
      protocol: 'http' as const,
      owner: {
        worktreeId: 'wt',
        repoId: 'repo',
        displayName: 'main',
        path: '/repo',
        confidence: 'cwd' as const
      }
    }
    const scan: WorkspacePortScanResult = { platform: 'unknown', scannedAt: 1, ports: [port] }
    expect(matchingWorkspaceServerPort(entry, scan)).toEqual(port)
    expect(
      matchingWorkspaceServerPort(entry, {
        ...scan,
        ports: [{ ...port, owner: { ...port.owner, worktreeId: 'other' } }]
      })
    ).toBeUndefined()
    expect(matchingWorkspaceServerPort(entry, { ...scan, ports: [] })).toBeUndefined()
  })
})
