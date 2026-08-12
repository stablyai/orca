import { describe, expect, it } from 'vitest'
import type {
  BrowserWorkspace,
  MemorySnapshot,
  TerminalTab,
  Worktree,
  WorktreeMemory
} from '../../../../shared/types'
import { mergeSnapshotAndSessions, UNATTRIBUTED_REPO_ID } from './mergeSnapshotAndSessions'
import { requiresKillConfirmation } from './resource-session-kill-confirmation'
import type { DaemonSession, MergeContext } from './resource-usage-merge-types'

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
      availableMemory: 8e9,
      availableMemorySource: 'free-memory',
      usedMemory: 8e9,
      memoryUsagePercent: 50,
      cpuCoreCount: 8,
      loadAverage1m: 0
    },
    processMemoryMetric: 'rss',
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
  repoRuntimeScopedById: new Map(),
  ...overrides
})

describe('mergeSnapshotAndSessions', () => {
  it('returns empty list when both inputs are empty', () => {
    expect(mergeSnapshotAndSessions(null, [], baseCtx())).toEqual([])
  })

  it('includes browser-only workspaces in their repo', () => {
    const worktree = {
      id: 'orca::/Users/me/browser-only',
      repoId: 'orca',
      displayName: 'browser-only'
    } as Worktree
    const browser = {
      id: 'browser-1',
      worktreeId: worktree.id,
      title: 'Orca docs',
      url: 'https://docs.orca.dev',
      loading: false,
      faviconUrl: null,
      canGoBack: false,
      canGoForward: false,
      loadError: null,
      createdAt: 1
    } as BrowserWorkspace
    const out = mergeSnapshotAndSessions(
      null,
      [],
      baseCtx({
        repoDisplayNameById: new Map([['orca', 'ORCA']]),
        worktreeById: new Map([[worktree.id, worktree]]),
        browserTabsByWorktree: { [worktree.id]: [browser] }
      })
    )

    expect(out[0]).toMatchObject({
      repoId: 'orca',
      repoName: 'ORCA',
      worktrees: [
        {
          worktreeId: worktree.id,
          worktreeName: 'browser-only',
          sessions: [],
          browsers: [browser]
        }
      ]
    })
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
    const ds: DaemonSession[] = [
      { id: 'pty-1', cwd: '/Users/me/Triton', title: 'shell', agentOwnership: 'absent' as const }
    ]
    const out = mergeSnapshotAndSessions(makeSnapshot([wt]), ds, baseCtx())
    expect(out[0].worktrees[0].sessions).toHaveLength(1)
    expect(out[0].worktrees[0].sessions[0]).toMatchObject({
      sessionId: 'pty-1',
      hasLocalSamples: true,
      cpu: 0.1,
      memory: 50_000_000
    })
  })

  it('carries agent ownership onto the snapshot-derived row for the same session', () => {
    // Why: only the daemon list reports ownership. A snapshot row describing the same session must
    // not report `false` — that row is the one whose kill skips confirmation (#8459).
    const wt: WorktreeMemory = {
      worktreeId: 'orca::/Users/me/Triton',
      worktreeName: 'Triton',
      repoId: 'orca',
      repoName: 'ORCA',
      cpu: 0.1,
      memory: 50_000_000,
      history: [],
      sessions: [{ sessionId: 'pty-agent', paneKey: null, pid: 999, cpu: 0.1, memory: 50_000_000 }]
    }
    const ds: DaemonSession[] = [
      {
        id: 'pty-agent',
        cwd: '/Users/me/Triton',
        title: 'codex',
        agentOwnership: 'present' as const
      }
    ]

    const out = mergeSnapshotAndSessions(makeSnapshot([wt]), ds, baseCtx())

    expect(out[0].worktrees[0].sessions[0]).toMatchObject({
      sessionId: 'pty-agent',
      agentOwnership: 'present' as const
    })
  })

  it('binds a deferred SSH row so its single-row kill cannot skip confirmation', () => {
    // Why: the bulk selector already excluded these, but the rendered row took its own path.
    // An unbound row with no agent skips the dialog entirely — the same #8459 defect, one click over.
    const sessionId = 'orca::/remote/Stingray@@deferred1'
    const out = mergeSnapshotAndSessions(
      null,
      [{ id: sessionId, cwd: '', title: 'orca/Stingray', agentOwnership: 'absent' as const }],
      baseCtx({
        tabsByWorktree: { 'orca::/remote/Stingray': [makeTab('tab-ssh')] },
        deferredSshSessionIdsByTabId: { 'tab-ssh': sessionId },
        repoConnectionIdById: new Map([['orca', 'ssh-conn-1']])
      })
    )

    const row = out[0].worktrees[0].sessions[0]
    expect(row).toMatchObject({ sessionId, bound: true, tabId: 'tab-ssh' })
    expect(requiresKillConfirmation(row)).toBe(true)
  })

  it('treats a snapshot row the daemon never listed as unknown ownership, not absent', () => {
    const wt: WorktreeMemory = {
      worktreeId: 'orca::/Users/me/Triton',
      worktreeName: 'Triton',
      repoId: 'orca',
      repoName: 'ORCA',
      cpu: 0.1,
      memory: 50_000_000,
      history: [],
      sessions: [{ sessionId: 'pty-only-local', paneKey: null, pid: 7, cpu: 0.1, memory: 1 }]
    }

    const out = mergeSnapshotAndSessions(makeSnapshot([wt]), [], baseCtx())

    expect(out[0].worktrees[0].sessions[0]).toMatchObject({ agentOwnership: 'unknown' })
    expect(requiresKillConfirmation(out[0].worktrees[0].sessions[0])).toBe(true)
  })

  it('@@ parse: an SSH-style session id resolves to its worktree group', () => {
    const ds: DaemonSession[] = [
      {
        id: 'orca::/remote/Stingray@@abcd1234',
        cwd: '',
        title: 'orca/Stingray',
        agentOwnership: 'absent' as const
      }
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
      {
        id: 'orca::/local/Triton@@deadbeef',
        cwd: '/local/Triton',
        title: 'orca/Triton',
        agentOwnership: 'absent' as const
      }
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
    const ds: DaemonSession[] = [
      {
        id: 'orca::/wrong/path@@feedface',
        cwd: '',
        title: 'orca',
        agentOwnership: 'absent' as const
      }
    ]
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

  it('treats startup deferred reattach tab ptyId wake hints as bound sessions', () => {
    const tabId = 'tab-restored'
    const sessionId = 'orca::/Users/me/Triton@@deferred'
    const ds: DaemonSession[] = [
      {
        id: sessionId,
        cwd: '/Users/me/Triton',
        title: 'orca/Triton',
        agentOwnership: 'absent' as const
      }
    ]
    const restoredTab = { ...makeTab(tabId, 'Restored'), ptyId: sessionId }
    const ctx = baseCtx({
      tabsByWorktree: {
        'orca::/Users/me/Triton': [restoredTab]
      },
      ptyIdsByTabId: { [tabId]: [] }
    })

    const out = mergeSnapshotAndSessions(null, ds, ctx)

    expect(out[0].worktrees[0].sessions[0]).toMatchObject({
      sessionId,
      bound: true,
      tabId
    })
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
      {
        id: 'remote-repo::/remote/Stingray@@1234',
        cwd: '',
        title: 'remote/Stingray',
        agentOwnership: 'absent' as const
      }
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

  it('excludes runtime-scoped rows while preserving SSH and unattributed sessions', () => {
    const runtimeWt: WorktreeMemory = {
      worktreeId: 'runtime-repo::/runtime/Wt',
      worktreeName: 'Wt',
      repoId: 'runtime-repo',
      repoName: 'RUNTIME',
      cpu: 5,
      memory: 500_000_000,
      history: [],
      sessions: [{ sessionId: 'runtime-pty', paneKey: null, pid: 2, cpu: 5, memory: 500_000_000 }]
    }
    const sessions: DaemonSession[] = [
      {
        id: 'runtime-repo::/runtime/Wt@@future-runtime',
        cwd: '',
        title: 'runtime/Wt',
        agentOwnership: 'absent' as const
      },
      {
        id: 'ssh-repo::/remote/Wt@@ssh-session',
        cwd: '',
        title: 'ssh/Wt',
        agentOwnership: 'absent' as const
      },
      {
        id: 'opaque-local-orphan',
        cwd: '',
        title: 'orphan shell',
        agentOwnership: 'absent' as const
      }
    ]
    const ctx = baseCtx({
      repoConnectionIdById: new Map<string, string | null>([
        ['runtime-repo', null],
        ['ssh-repo', 'ssh-target-1']
      ]),
      repoRuntimeScopedById: new Map([
        ['runtime-repo', true],
        ['ssh-repo', false]
      ])
    })

    const out = mergeSnapshotAndSessions(makeSnapshot([runtimeWt]), sessions, ctx)

    expect(out.map((repo) => repo.repoId)).toEqual(['ssh-repo', UNATTRIBUTED_REPO_ID])
    expect(out.find((repo) => repo.repoId === 'runtime-repo')).toBeUndefined()

    const ssh = out.find((repo) => repo.repoId === 'ssh-repo')!
    expect(ssh.hasRemoteChildren).toBe(true)
    expect(ssh.worktrees[0]).toMatchObject({
      isRemote: true,
      cpu: null,
      memory: null
    })
    expect(ssh.worktrees[0].sessions[0]).toMatchObject({
      sessionId: 'ssh-repo::/remote/Wt@@ssh-session',
      bound: false
    })

    const orphan = out.find((repo) => repo.repoId === UNATTRIBUTED_REPO_ID)!
    expect(orphan.hasRemoteChildren).toBe(false)
    expect(orphan.worktrees[0].sessions[0]).toMatchObject({
      sessionId: 'opaque-local-orphan',
      bound: false
    })
  })

  it('unresolvable session falls into unattributed bucket without flagging remote', () => {
    // Why: under the connectionId predicate, an unresolved session is
    // not evidence of remoteness — we just don't know what it belongs
    // to. The chip should stay off; the row still surfaces in the
    // unattributed bucket with `—` cells because we have no sample.
    const ds: DaemonSession[] = [
      { id: 'opaque-id-without-prefix', cwd: '', title: 'shell', agentOwnership: 'absent' as const }
    ]
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
    const ds: DaemonSession[] = [
      {
        id: 'orca::/remote/Wt@@deadbeef',
        cwd: '',
        title: 'orca/Wt',
        agentOwnership: 'absent' as const
      }
    ]
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

  it('uses repoDisplayNameById to humanize new project groups when available', () => {
    const ds: DaemonSession[] = [
      { id: 'stably-ai/orca::/remote/Wt@@1', cwd: '', title: '', agentOwnership: 'absent' as const }
    ]
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
