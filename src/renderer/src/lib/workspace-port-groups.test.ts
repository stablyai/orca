import { describe, expect, it } from 'vitest'
import {
  getExternalWorkspacePorts,
  getWorkspacePortGroups,
  getWorkspacePortsByWorktreeId,
  sortWorkspacePortGroupsByMetric,
  sortWorkspacePortsByMetric,
  type WorkspacePortGroup
} from './workspace-port-groups'
import type { WorkspacePort } from '../../../shared/workspace-ports'

describe('workspace port group caches', () => {
  it('returns stable empty references when no scan result exists', () => {
    expect(getWorkspacePortsByWorktreeId(null)).toBe(getWorkspacePortsByWorktreeId(undefined))
    expect(getWorkspacePortGroups(null)).toBe(getWorkspacePortGroups(undefined))
    expect(getExternalWorkspacePorts(null)).toBe(getExternalWorkspacePorts(undefined))
  })
})

function port(overrides: Partial<WorkspacePort> & { id: string }): WorkspacePort {
  return {
    bindHost: '127.0.0.1',
    connectHost: '127.0.0.1',
    port: 3000,
    protocol: 'http',
    kind: 'external',
    ...overrides
  } as WorkspacePort
}

describe('sortWorkspacePortsByMetric', () => {
  it('sorts ports by uptime descending, null last', () => {
    const ports = [
      port({ id: 'a', processName: 'a', uptimeSeconds: 10 }),
      port({ id: 'b', processName: 'b', uptimeSeconds: undefined }),
      port({ id: 'c', processName: 'c', uptimeSeconds: 500 })
    ]

    expect(sortWorkspacePortsByMetric(ports, 'uptime').map((p) => p.id)).toEqual(['c', 'a', 'b'])
  })
})

describe('sortWorkspacePortGroupsByMetric', () => {
  it('ranks groups by their longest-running port, not a summed age', () => {
    const groups: WorkspacePortGroup[] = [
      {
        worktreeId: 'wt-recent',
        repoId: 'repo',
        displayName: 'recent',
        ports: [port({ id: 'r1', uptimeSeconds: 100 }), port({ id: 'r2', uptimeSeconds: 100 })]
      },
      {
        worktreeId: 'wt-old',
        repoId: 'repo',
        displayName: 'old',
        ports: [port({ id: 'o1', uptimeSeconds: 500 })]
      }
    ]

    const sorted = sortWorkspacePortGroupsByMetric(groups, 'uptime')

    // wt-old's single port (500s) outranks wt-recent's pair (100s each,
    // 200s if summed) — proves this uses max, not sum, per group.
    expect(sorted.map((g) => g.worktreeId)).toEqual(['wt-old', 'wt-recent'])
  })

  it('counts a process bound to multiple ports only once when summing memory', () => {
    // Regression: a dev server on IPv4 + IPv6 reports the same process-level
    // memory on both rows — summing both would double-count it and let this
    // group (1000+1000=2000, buggy) outrank the single-port group (1500).
    const groups: WorkspacePortGroup[] = [
      {
        worktreeId: 'wt-dup',
        repoId: 'repo',
        displayName: 'dup',
        ports: [port({ id: 'd1', pid: 7, memory: 1000 }), port({ id: 'd2', pid: 7, memory: 1000 })]
      },
      {
        worktreeId: 'wt-single',
        repoId: 'repo',
        displayName: 'single',
        ports: [port({ id: 's1', pid: 99, memory: 1500 })]
      }
    ]

    const sorted = sortWorkspacePortGroupsByMetric(groups, 'memory')

    expect(sorted.map((g) => g.worktreeId)).toEqual(['wt-single', 'wt-dup'])
  })

  it('always keeps ports grouped under their project, never flattened', () => {
    const groups: WorkspacePortGroup[] = [
      {
        worktreeId: 'wt-a',
        repoId: 'repo',
        displayName: 'a',
        ports: [port({ id: 'a1', uptimeSeconds: 1 })]
      },
      {
        worktreeId: 'wt-b',
        repoId: 'repo',
        displayName: 'b',
        ports: [port({ id: 'b1', uptimeSeconds: 999 })]
      }
    ]

    const sorted = sortWorkspacePortGroupsByMetric(groups, 'uptime')

    expect(sorted.every((g) => g.ports.length === 1)).toBe(true)
    expect(sorted.map((g) => g.ports[0].id)).toEqual(['b1', 'a1'])
  })
})
