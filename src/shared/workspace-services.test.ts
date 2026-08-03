import { describe, expect, it } from 'vitest'
import {
  selectOrphanServices,
  selectServicesForOtherWorktrees,
  selectServicesForWorktree,
  type WorkspaceService
} from './workspace-services'

function service(overrides: Partial<WorkspaceService> = {}): WorkspaceService {
  return {
    id: 'svc-1',
    kind: 'process',
    port: 3939,
    address: 'localhost:3939',
    serviceName: 'market',
    launchCommand: 'pnpm dev',
    launchedByAgent: 'Claude Code',
    projectName: 'mono-numis-store',
    projectRoot: '/repo',
    workingDir: '/repo/apps/market',
    pid: 3232,
    processName: 'next-server',
    owner: null,
    isOrphan: false,
    container: null,
    ...overrides
  }
}

function owned(worktreeId: string, repoId: string): WorkspaceService['owner'] {
  return {
    worktreeId,
    repoId,
    displayName: worktreeId,
    path: `/wt/${worktreeId}`,
    confidence: 'cwd'
  }
}

describe('selectServicesForWorktree', () => {
  it('keeps only services owned by the active worktree', () => {
    const services = [
      service({ id: 'a', owner: owned('wt-1', 'repo-1') }),
      service({ id: 'b', owner: owned('wt-2', 'repo-1') }),
      service({ id: 'c', owner: null })
    ]

    expect(selectServicesForWorktree(services, 'wt-1').map((s) => s.id)).toEqual(['a'])
  })

  it('returns nothing when no worktree is active, rather than everything', () => {
    const services = [service({ owner: owned('wt-1', 'repo-1') })]

    expect(selectServicesForWorktree(services, null)).toEqual([])
  })

  it('excludes unattributed services from the project-scoped list', () => {
    // A service we cannot attribute must not be claimed by the active project.
    expect(selectServicesForWorktree([service({ owner: null })], 'wt-1')).toEqual([])
  })
})

describe('selectServicesForOtherWorktrees', () => {
  it('keeps sibling worktrees of the same repo', () => {
    const services = [
      service({ id: 'a', owner: owned('wt-1', 'repo-1') }),
      service({ id: 'b', owner: owned('wt-2', 'repo-1') }),
      service({ id: 'c', owner: owned('wt-3', 'repo-2') })
    ]

    expect(selectServicesForOtherWorktrees(services, 'repo-1', 'wt-1').map((s) => s.id)).toEqual([
      'b'
    ])
  })

  it('never includes another repo', () => {
    const services = [service({ owner: owned('wt-9', 'repo-2') })]

    expect(selectServicesForOtherWorktrees(services, 'repo-1', 'wt-1')).toEqual([])
  })
})

describe('selectOrphanServices', () => {
  it('ignores the project filter entirely', () => {
    const services = [
      service({ id: 'a', isOrphan: true, owner: null, projectName: null }),
      service({ id: 'b', isOrphan: true, owner: owned('wt-9', 'repo-9') }),
      service({ id: 'c', isOrphan: false, owner: owned('wt-1', 'repo-1') })
    ]

    expect(selectOrphanServices(services).map((s) => s.id)).toEqual(['a', 'b'])
  })

  it('returns nothing when every workspace still exists', () => {
    expect(selectOrphanServices([service({ isOrphan: false })])).toEqual([])
  })
})
