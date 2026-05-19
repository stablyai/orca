/* eslint-disable max-lines -- Why: this file co-locates tightly-coupled scenario
   tests for the resource-usage merge function. Splitting them weakens the
   single-source view of how snapshot + daemon-session inputs combine. */
import { describe, expect, it } from 'vitest'
import type { MemorySnapshot, TerminalTab, WorktreeMemory } from '../../../../shared/types'
import {
  mergeSnapshotAndSessions,
  UNATTRIBUTED_REPO_ID,
  type DaemonSession,
  type MergeContext
} from './mergeSnapshotAndSessions'

function emptyAppMemory() {
  return {
    cpu: 0,
    memory: 0,
    main: { cpu: 0, memory: 0 },
    renderer: { cpu: 0, memory: 0 },
    other: { cpu: 0, memory: 0 },
    history: []
  }
}

function makeSnapshot(worktrees: WorktreeMemory[]): MemorySnapshot {
  return {
    app: emptyAppMemory(),
    worktrees,
    host: {
      totalMemory: 16e9,
      freeMemory: 8e9,
      usedMemory: 8e9,
      memoryUsagePercent: 50,
      cpuCoreCount: 8,
      loadAverage1m: 0
    },
    totalCpu: worktrees.reduce((s, w) => s + w.cpu, 0),
    totalMemory: worktrees.reduce((s, w) => s + w.memory, 0),
    collectedAt: 0
  }
}

function makeTab(id: string, defaultTitle = 'Terminal'): TerminalTab {
  return {
    id,
    title: defaultTitle,
    defaultTitle,
    customTitle: null,
    type: 'terminal',
    paneCount: 1
  } as unknown as TerminalTab
}

const baseCtx = (overrides: Partial<MergeContext> = {}): MergeContext => ({
  tabsByWorktree: {},
  ptyIdsByTabId: {},
  runtimePaneTitlesByTabId: {},
  workspaceSessionReady: true,
  repoDisplayNameById: new Map(),
  repoConnectionIdById: new Map(),
  ...overrides
})

describe('mergeSnapshotAndSessions', () => {
  it('returns empty list when both inputs are empty', () => {
    expect(mergeSnapshotAndSessions(null, [], baseCtx())).toEqual([])
  })

  it('passes through snapshot worktrees with numeric metrics and hasLocalSamples', () => {
    const wt: WorktreeMemory = {
      worktreeId: 'orca::/Users/me/Triton',
      worktreeName: 'Triton',
      repoId: 'orca',
      repoName: 'ORCA',
      cpu: 1.5,
      memory: 100_000_000,
      history: [1, 2, 3],
      sessions: [{ sessionId: 'pty-1', paneKey: null, pid: 1234, cpu: 1.5, memory: 100_000_000 }]
    }
    const out = mergeSnapshotAndSessions(makeSnapshot([wt]), [], baseCtx())
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      repoId: 'orca',
      repoName: 'ORCA',
      cpu: 1.5,
      memory: 100_000_000,
      hasRemoteChildren: false
    })
    expect(out[0].worktrees[0]).toMatchObject({
      worktreeName: 'Triton',
      cpu: 1.5,
      memory: 100_000_000,
      hasLocalSamples: true
    })
    expect(out[0].worktrees[0].sessions[0]).toMatchObject({
      sessionId: 'pty-1',
      cpu: 1.5,
      memory: 100_000_000,
      hasLocalSamples: true
    })
  })

  it('dedups: a session present in both snapshot and daemon list renders once with numeric metrics', () => {
    const wt: WorktreeMemory = {
      worktreeId: 'orca::/Users/me/Triton',
      worktreeName: 'Triton',
      repoId: 'orca',
      repoName: 'ORCA',
      cpu: 0.1,
      memory: 50_000_000,
      history: [],
      sessions: [{ sessionId: 'pty-1', paneKey: null, pid: 999, cpu: 0.1, memory: 50_000_000 }]
    }
    const ds: DaemonSession[] = [{ id: 'pty-1', cwd: '/Users/me/Triton', title: 'shell' }]
    const out = mergeSnapshotAndSessions(makeSnapshot([wt]), ds, baseCtx())
    expect(out[0].worktrees[0].sessions).toHaveLength(1)
    expect(out[0].worktrees[0].sessions[0]).toMatchObject({
      sessionId: 'pty-1',
      hasLocalSamples: true,
      cpu: 0.1,
      memory: 50_000_000
    })
  })

  it('@@ parse: an SSH-style session id resolves to its worktree group', () => {
    const ds: DaemonSession[] = [
      { id: 'orca::/remote/Stingray@@abcd1234', cwd: '', title: 'orca/Stingray' }
    ]
    const ctx = baseCtx({
      repoConnectionIdById: new Map([['orca', 'ssh-conn-1']])
    })
    const out = mergeSnapshotAndSessions(null, ds, ctx)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      repoId: 'orca',
      hasRemoteChildren: true,
      cpu: null,
      memory: null
    })
    expect(out[0].worktrees[0]).toMatchObject({
      worktreeId: 'orca::/remote/Stingray',
      worktreeName: 'Stingray',
      hasLocalSamples: false,
      isRemote: true,
      cpu: null,
      memory: null
    })
    expect(out[0].worktrees[0].sessions[0]).toMatchObject({
      sessionId: 'orca::/remote/Stingray@@abcd1234',
      hasLocalSamples: false,
      cpu: null,
      memory: null,
      bound: false
    })
  })

  it('warm-reattach local PTY: chip stays off when repo has no connectionId', () => {
    // Why: regression coverage for the warm-reattach REMOTE mislabel.
    // A live local daemon session whose registry entry the renderer hasn't
    // re-spawned yet must NOT be flagged as remote. Under the old
    // predicate (`!hasLocalSamples`) it was — that was the bug.
    const ds: DaemonSession[] = [
      { id: 'orca::/local/Triton@@deadbeef', cwd: '/local/Triton', title: 'orca/Triton' }
    ]
    const ctx = baseCtx({
      repoConnectionIdById: new Map([['orca', null]])
    })
    const out = mergeSnapshotAndSessions(null, ds, ctx)
    expect(out[0]).toMatchObject({
      repoId: 'orca',
      hasRemoteChildren: false
    })
    expect(out[0].worktrees[0]).toMatchObject({
      hasLocalSamples: false,
      isRemote: false
    })
  })

  it('tab walk wins over @@ parse when they disagree', () => {
    const tabId = 'tab-xyz'
    const ds: DaemonSession[] = [{ id: 'orca::/wrong/path@@feedface', cwd: '', title: 'orca' }]
    const ctx = baseCtx({
      tabsByWorktree: {
        'orca::/correct/path': [makeTab(tabId, 'My Tab')]
      },
      ptyIdsByTabId: { [tabId]: ['orca::/wrong/path@@feedface'] }
    })
    const out = mergeSnapshotAndSessions(null, ds, ctx)
    expect(out[0].worktrees[0].worktreeId).toBe('orca::/correct/path')
    expect(out[0].worktrees[0].sessions[0].tabId).toBe(tabId)
    expect(out[0].worktrees[0].sessions[0].bound).toBe(true)
  })

  it('repo aggregate sums only worktrees with numeric metrics; remote-by-connectionId flags chip', () => {
    // Why: a single repo can be both reflected as a snapshot worktree
    // (covered by the local collector) and a daemon-only session
    // (not in the snapshot). Under the connectionId predicate, the
    // chip flips for the *remote* repo case; the local repo keeps
    // numeric aggregates and no chip. Each scenario is verified with
    // its own single-repo input.
    const localWt: WorktreeMemory = {
      worktreeId: 'local-repo::/local/Triton',
      worktreeName: 'Triton',
      repoId: 'local-repo',
      repoName: 'LOCAL',
      cpu: 0.5,
      memory: 125_000_000,
      history: [],
      sessions: []
    }
    const remoteDs: DaemonSession[] = [
      { id: 'remote-repo::/remote/Stingray@@1234', cwd: '', title: 'remote/Stingray' }
    ]
    const ctx = baseCtx({
      repoConnectionIdById: new Map<string, string | null>([
        ['local-repo', null],
        ['remote-repo', 'ssh-conn-1']
      ])
    })
    const out = mergeSnapshotAndSessions(makeSnapshot([localWt]), remoteDs, ctx)
    expect(out).toHaveLength(2)
    const local = out.find((r) => r.repoId === 'local-repo')!
    const remote = out.find((r) => r.repoId === 'remote-repo')!
    expect(local).toMatchObject({
      cpu: 0.5,
      memory: 125_000_000,
      hasRemoteChildren: false
    })
    expect(remote).toMatchObject({
      cpu: null,
      memory: null,
      hasRemoteChildren: true
    })
    expect(local.worktrees[0].isRemote).toBe(false)
    expect(remote.worktrees[0].isRemote).toBe(true)
  })

  it('unresolvable session falls into unattributed bucket without flagging remote', () => {
    // Why: under the connectionId predicate, an unresolved session is
    // not evidence of remoteness — we just don't know what it belongs
    // to. The chip should stay off; the row still surfaces in the
    // unattributed bucket with `—` cells because we have no sample.
    const ds: DaemonSession[] = [{ id: 'opaque-id-without-prefix', cwd: '', title: 'shell' }]
    const out = mergeSnapshotAndSessions(null, ds, baseCtx())
    expect(out).toHaveLength(1)
    expect(out[0].repoId).toBe(UNATTRIBUTED_REPO_ID)
    expect(out[0].hasRemoteChildren).toBe(false)
    expect(out[0].worktrees[0].sessions[0].sessionId).toBe('opaque-id-without-prefix')
  })

  it('local-bound interaction state: numeric metrics + bound=true + tabId set', () => {
    const tabId = 'tab-1'
    const wt: WorktreeMemory = {
      worktreeId: 'orca::/Users/me/Triton',
      worktreeName: 'Triton',
      repoId: 'orca',
      repoName: 'ORCA',
      cpu: 0.1,
      memory: 1_000,
      history: [],
      sessions: [{ sessionId: 'pty-bound', paneKey: null, pid: 1, cpu: 0.1, memory: 1_000 }]
    }
    const ctx = baseCtx({
      tabsByWorktree: { 'orca::/Users/me/Triton': [makeTab(tabId)] },
      ptyIdsByTabId: { [tabId]: ['pty-bound'] }
    })
    const out = mergeSnapshotAndSessions(makeSnapshot([wt]), [], ctx)
    const session = out[0].worktrees[0].sessions[0]
    expect(session).toMatchObject({
      hasLocalSamples: true,
      bound: true,
      tabId
    })
  })

  it('local-orphan interaction state: numeric metrics + bound=false + tabId null', () => {
    const wt: WorktreeMemory = {
      worktreeId: 'orca::/Users/me/Triton',
      worktreeName: 'Triton',
      repoId: 'orca',
      repoName: 'ORCA',
      cpu: 0,
      memory: 0,
      history: [],
      sessions: [{ sessionId: 'pty-orph', paneKey: null, pid: 0, cpu: 0, memory: 0 }]
    }
    const out = mergeSnapshotAndSessions(makeSnapshot([wt]), [], baseCtx())
    const session = out[0].worktrees[0].sessions[0]
    expect(session.bound).toBe(false)
    expect(session.tabId).toBeNull()
    expect(session.hasLocalSamples).toBe(true)
  })

  it('remote-orphan interaction state: null metrics + bound=false', () => {
    const ds: DaemonSession[] = [{ id: 'orca::/remote/Wt@@deadbeef', cwd: '', title: 'orca/Wt' }]
    const out = mergeSnapshotAndSessions(null, ds, baseCtx())
    const session = out[0].worktrees[0].sessions[0]
    expect(session).toMatchObject({
      hasLocalSamples: false,
      cpu: null,
      memory: null,
      bound: false,
      tabId: null
    })
  })

  it('uses repoDisplayNameById to humanize new repo groups when available', () => {
    const ds: DaemonSession[] = [{ id: 'stably-ai/orca::/remote/Wt@@1', cwd: '', title: '' }]
    const ctx = baseCtx({
      repoDisplayNameById: new Map([['stably-ai/orca', 'ORCA']])
    })
    const out = mergeSnapshotAndSessions(null, ds, ctx)
    expect(out[0].repoName).toBe('ORCA')
  })

  it('workspaceSessionReady=false suppresses bound flags so nothing looks bound prematurely', () => {
    const tabId = 'tab-1'
    const wt: WorktreeMemory = {
      worktreeId: 'orca::/Users/me/Triton',
      worktreeName: 'Triton',
      repoId: 'orca',
      repoName: 'ORCA',
      cpu: 0,
      memory: 0,
      history: [],
      sessions: [{ sessionId: 'pty-1', paneKey: null, pid: 1, cpu: 0, memory: 0 }]
    }
    const ctx = baseCtx({
      workspaceSessionReady: false,
      tabsByWorktree: { 'orca::/Users/me/Triton': [makeTab(tabId)] },
      ptyIdsByTabId: { [tabId]: ['pty-1'] }
    })
    const out = mergeSnapshotAndSessions(makeSnapshot([wt]), [], ctx)
    expect(out[0].worktrees[0].sessions[0].bound).toBe(false)
  })
})
