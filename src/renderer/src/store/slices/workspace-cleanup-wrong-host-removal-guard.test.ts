/**
 * STA-4343 (minimal fail-closed guard): workspace cleanup must never delete on a
 * host other than the one whose row was confirmed.
 *
 * Two hosts can expose cleanup candidates with the SAME `repoId::path` identity
 * (the scan composes `worktreeId` from `repo.id` + `::` + the workspace path with
 * no host component). Selection, confirmation and preflight all key on
 * `worktreeId` alone, and removal routing prefers the ACTIVE workspace's host, so
 * confirming host B's row issued the destructive IPC against host A and destroyed
 * host A's real directory (and its uncommitted work).
 *
 * This is the MINIMAL fix: refuse the removal when ownership is not certain.
 * Routing a colliding row to its right host is PR #14606's job.
 *
 * Rig: two REAL temp directories stand in for the two hosts. The removal boundary
 * (`window.api.worktrees.remove`) is the only fake, and it ACTUALLY deletes the
 * directory on the host it is routed to. The gate is filesystem state, not
 * arguments. The single-host control deletes for real through the same rig, so a
 * passing refusal assertion cannot come from a rig that never deletes anything.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ExecutionHostId } from '../../../../shared/execution-host'

const NOW = 1_700_000_000_000
const HOST_A_HOST_ID: ExecutionHostId = 'local'
const HOST_B_HOST_ID: ExecutionHostId = 'ssh:ssh-1'
const HOST_COLLISION_MESSAGE = 'Error: this workspace exists on multiple hosts at the same path'
const HOST_UNRESOLVED_MESSAGE =
  'Orca cannot tell which host owns this workspace. Refresh projects and review it again.'

const mockApi = {
  worktrees: {
    remove: vi.fn(),
    forgetLocal: vi.fn().mockResolvedValue({ ok: false, error: 'unused in this scenario' })
  },
  hooks: {
    check: vi.fn().mockResolvedValue({ hasHooks: false, hooks: null, mayNeedUpdate: false })
  },
  workspaceCleanup: {
    scan: vi.fn(),
    dismiss: vi.fn().mockResolvedValue(undefined),
    clearDismissals: vi.fn().mockResolvedValue(undefined),
    recordRemovalSnapshotPrune: vi.fn().mockResolvedValue(undefined)
  },
  pty: { kill: vi.fn().mockResolvedValue(undefined) },
  runtimeEnvironments: { call: vi.fn().mockResolvedValue({ ok: true, result: {} } as never) },
  ephemeralVm: {
    listRuntimes: vi.fn().mockResolvedValue([]),
    cleanup: vi.fn().mockResolvedValue({})
  }
}

// @ts-expect-error -- minimal window.api stub for the store under test
globalThis.window = { api: mockApi }

import { createTestStore, seedStore, makeTab, makeWorktree } from './store-test-helpers'
import { resetAuthoritativelyRemovedWorktreeMemoryForTests } from './worktrees'
import type { AppState } from '../types'
import type {
  WorkspaceCleanupCandidate,
  WorkspaceCleanupScanResult
} from '../../../../shared/workspace-cleanup'

const WORKTREE_ID = 'repo1::/shared/workspace/path'
const WORKTREE_PATH = '/shared/workspace/path'
const FIRST_WORKTREE_ID = 'repo1::/first/very-long-workspace/path'

function makeHostCandidate(
  executionHostId: ExecutionHostId | undefined,
  connectionId: string | null = executionHostId === HOST_B_HOST_ID ? 'ssh-1' : null,
  worktreeId = WORKTREE_ID
): WorkspaceCleanupCandidate {
  const workspacePath = worktreeId.slice(worktreeId.indexOf('::') + 2)
  return {
    worktreeId,
    repoId: 'repo1',
    repoName: 'Repo 1',
    connectionId,
    ...(executionHostId ? { executionHostId } : {}),
    displayName: 'shared-workspace',
    branch: 'old-branch',
    path: workspacePath,
    tier: 'ready',
    selectedByDefault: true,
    reasons: ['idle-clean'],
    blockers: [],
    lastActivityAt: NOW - 30 * 24 * 60 * 60 * 1000,
    localContext: {
      terminalTabCount: 0,
      cleanEditorTabCount: 0,
      browserTabCount: 0,
      diffCommentCount: 0,
      newestDiffCommentAt: null,
      retainedDoneAgentCount: 0
    },
    git: { clean: true, upstreamAhead: 0, upstreamBehind: 0, checkedAt: NOW },
    fingerprint: `fingerprint-${executionHostId ?? 'unqualified'}`
  }
}

type HostDirectories = {
  hostARoot: string
  hostBRoot: string
  hostAMarkerPath: string
  hostBMarkerPath: string
}

const hostDirCleanup: (() => void)[] = []

/** Maps a workspace id onto a per-host temp directory; Windows ids keep their shape. */
function toHostRelativePath(worktreeId: string): string {
  return worktreeId
    .slice(worktreeId.indexOf('::') + 2)
    .replace(/^[a-zA-Z]:/, '')
    .split(/[/\\]+/)
    .filter((segment) => segment.length > 0)
    .join(path.sep)
}

function createHostDirectories(): HostDirectories {
  const hostARoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sta4343-guard-host-a-'))
  const hostBRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sta4343-guard-host-b-'))
  hostDirCleanup.push(() => {
    fs.rmSync(hostARoot, { recursive: true, force: true })
    fs.rmSync(hostBRoot, { recursive: true, force: true })
  })
  const relativePath = toHostRelativePath(WORKTREE_ID)
  const hostAWorktreeDir = path.join(hostARoot, relativePath)
  const hostBWorktreeDir = path.join(hostBRoot, relativePath)
  fs.mkdirSync(hostAWorktreeDir, { recursive: true })
  fs.mkdirSync(hostBWorktreeDir, { recursive: true })
  const hostAMarkerPath = path.join(hostAWorktreeDir, 'HOST_A_MARKER')
  const hostBMarkerPath = path.join(hostBWorktreeDir, 'HOST_B_MARKER')
  fs.writeFileSync(hostAMarkerPath, 'uncommitted-data-on-host-a')
  fs.writeFileSync(hostBMarkerPath, 'uncommitted-data-on-host-b')
  return { hostARoot, hostBRoot, hostAMarkerPath, hostBMarkerPath }
}

/** Deletes for real on whichever host the removal is routed to. */
function installRemovalTransport(
  hostRootsByHostId: Record<string, string>,
  routedHostIds: string[]
): void {
  mockApi.worktrees.remove.mockImplementation(
    async (args: { worktreeId: string; hostId?: string }) => {
      routedHostIds.push(args.hostId ?? '<missing>')
      const hostRoot = args.hostId ? hostRootsByHostId[args.hostId] : undefined
      if (hostRoot) {
        fs.rmSync(path.join(hostRoot, toHostRelativePath(args.worktreeId)), {
          recursive: true,
          force: true
        })
      }
      return { ok: true }
    }
  )
}

function seedScan(candidates: readonly WorkspaceCleanupCandidate[]): void {
  mockApi.workspaceCleanup.scan.mockResolvedValue({
    scannedAt: NOW,
    candidates: [...candidates],
    errors: []
  } satisfies WorkspaceCleanupScanResult)
}

beforeEach(() => {
  resetAuthoritativelyRemovedWorktreeMemoryForTests()
})

afterEach(() => {
  vi.clearAllMocks()
  for (const cleanup of hostDirCleanup.splice(0)) {
    cleanup()
  }
})

describe('STA-4343 minimal guard: cleanup refuses a removal it cannot attribute to a host', () => {
  it('confirming host B leaves ACTIVE host A intact when both hosts hold the same id', async () => {
    const hosts = createHostDirectories()
    const routedHostIds: string[] = []
    installRemovalTransport(
      { [HOST_A_HOST_ID]: hosts.hostARoot, [HOST_B_HOST_ID]: hosts.hostBRoot },
      routedHostIds
    )
    const hostBCandidate = makeHostCandidate(HOST_B_HOST_ID)
    seedScan([makeHostCandidate(HOST_A_HOST_ID), hostBCandidate])

    const store = createTestStore()
    // Host A owns the ACTIVE workspace, so removal routing prefers host A.
    seedStore(store, {
      activeWorktreeId: WORKTREE_ID,
      activeWorkspaceExecutionHostId: HOST_A_HOST_ID,
      worktreesByRepo: {
        repo1: [
          makeWorktree({
            id: WORKTREE_ID,
            repoId: 'repo1',
            path: WORKTREE_PATH,
            hostId: HOST_A_HOST_ID
          }),
          makeWorktree({
            id: WORKTREE_ID,
            repoId: 'repo1',
            path: WORKTREE_PATH,
            hostId: HOST_B_HOST_ID
          })
        ]
      },
      tabsByWorktree: { [WORKTREE_ID]: [makeTab({ id: 'host-a-tab', worktreeId: WORKTREE_ID })] }
    } as Partial<AppState>)

    // The user confirms HOST B's cleanup row.
    const removal = await store
      .getState()
      .removeWorkspaceCleanupCandidates([WORKTREE_ID], { approvedCandidates: [hostBCandidate] })

    expect(
      fs.existsSync(hosts.hostAMarkerPath),
      `HOST A (active) worktree directory must still exist after confirming HOST B's row. worktrees.remove was routed to hostId=${routedHostIds.join(',')}`
    ).toBe(true)
    // Minimal fix: the colliding row is refused, not rerouted (#14606 reroutes it).
    expect(fs.existsSync(hosts.hostBMarkerPath)).toBe(true)
    expect(routedHostIds).toEqual([])
    expect(removal.removedIds).toEqual([])
    expect(removal.failures).toEqual([
      { worktreeId: WORKTREE_ID, displayName: 'shared-workspace', message: HOST_COLLISION_MESSAGE }
    ])
    expect(store.getState().tabsByWorktree[WORKTREE_ID]).toEqual([
      expect.objectContaining({ id: 'host-a-tab' })
    ])
  })

  it('refuses a row whose confirmed host no longer matches the refreshed scan', async () => {
    const hosts = createHostDirectories()
    const routedHostIds: string[] = []
    installRemovalTransport(
      { [HOST_A_HOST_ID]: hosts.hostARoot, [HOST_B_HOST_ID]: hosts.hostBRoot },
      routedHostIds
    )
    // The refreshed scan only reaches host A, but host B's row was confirmed.
    seedScan([makeHostCandidate(HOST_A_HOST_ID)])

    const store = createTestStore()
    seedStore(store, {
      worktreesByRepo: {
        repo1: [
          makeWorktree({
            id: WORKTREE_ID,
            repoId: 'repo1',
            path: WORKTREE_PATH,
            hostId: HOST_A_HOST_ID
          })
        ]
      }
    } as Partial<AppState>)

    const removal = await store.getState().removeWorkspaceCleanupCandidates([WORKTREE_ID], {
      approvedCandidates: [makeHostCandidate(HOST_B_HOST_ID)]
    })

    expect(fs.existsSync(hosts.hostAMarkerPath), 'host A must survive').toBe(true)
    expect(routedHostIds).toEqual([])
    expect(removal.failures).toEqual([
      { worktreeId: WORKTREE_ID, displayName: 'shared-workspace', message: HOST_UNRESOLVED_MESSAGE }
    ])
  })

  it('refuses a row that carries no host evidence at all', async () => {
    const hosts = createHostDirectories()
    const routedHostIds: string[] = []
    installRemovalTransport({ [HOST_A_HOST_ID]: hosts.hostARoot }, routedHostIds)
    const unqualifiedCandidate = makeHostCandidate(undefined, null)
    seedScan([unqualifiedCandidate])

    const store = createTestStore()
    seedStore(store, {
      worktreesByRepo: {
        repo1: [
          makeWorktree({
            id: WORKTREE_ID,
            repoId: 'repo1',
            path: WORKTREE_PATH,
            hostId: HOST_A_HOST_ID
          })
        ]
      }
    } as Partial<AppState>)

    const removal = await store.getState().removeWorkspaceCleanupCandidates([WORKTREE_ID], {
      approvedCandidates: [unqualifiedCandidate]
    })

    expect(fs.existsSync(hosts.hostAMarkerPath), 'host A must survive').toBe(true)
    expect(routedHostIds).toEqual([])
    expect(removal.failures).toEqual([
      { worktreeId: WORKTREE_ID, displayName: 'shared-workspace', message: HOST_UNRESOLVED_MESSAGE }
    ])
  })

  it('rechecks the route after an earlier removal changes ownership', async () => {
    const hosts = createHostDirectories()
    const routedHostIds: string[] = []
    installRemovalTransport(
      { [HOST_A_HOST_ID]: hosts.hostARoot, [HOST_B_HOST_ID]: hosts.hostBRoot },
      routedHostIds
    )
    const firstCandidate = makeHostCandidate(HOST_A_HOST_ID, null, FIRST_WORKTREE_ID)
    const secondCandidate = makeHostCandidate(HOST_A_HOST_ID)
    seedScan([firstCandidate, secondCandidate])

    const store = createTestStore()
    const firstWorktree = makeWorktree({
      id: FIRST_WORKTREE_ID,
      repoId: 'repo1',
      path: '/first/very-long-workspace/path',
      hostId: HOST_A_HOST_ID
    })
    const secondHostAWorktree = makeWorktree({
      id: WORKTREE_ID,
      repoId: 'repo1',
      path: WORKTREE_PATH,
      hostId: HOST_A_HOST_ID
    })
    const secondHostBWorktree = makeWorktree({
      id: WORKTREE_ID,
      repoId: 'repo1',
      path: WORKTREE_PATH,
      hostId: HOST_B_HOST_ID
    })
    seedStore(store, {
      worktreesByRepo: { repo1: [firstWorktree, secondHostAWorktree] }
    } as Partial<AppState>)
    const originalRemoveWorktree = store.getState().removeWorktree
    store.setState({
      removeWorktree: vi.fn(async (...args: Parameters<typeof originalRemoveWorktree>) => {
        const result = await originalRemoveWorktree(...args)
        if (args[0] === FIRST_WORKTREE_ID) {
          store.setState({
            activeWorktreeId: WORKTREE_ID,
            activeWorkspaceExecutionHostId: HOST_B_HOST_ID,
            worktreesByRepo: { repo1: [secondHostAWorktree, secondHostBWorktree] }
          })
        }
        return result
      })
    })

    const removal = await store
      .getState()
      .removeWorkspaceCleanupCandidates([FIRST_WORKTREE_ID, WORKTREE_ID], {
        approvedCandidates: [firstCandidate, secondCandidate]
      })

    expect(fs.existsSync(hosts.hostBMarkerPath), 'newly active host B must survive').toBe(true)
    expect(routedHostIds).toEqual([HOST_A_HOST_ID])
    expect(removal.removedIds).toEqual([FIRST_WORKTREE_ID])
    expect(removal.failures).toEqual([
      { worktreeId: WORKTREE_ID, displayName: 'shared-workspace', message: HOST_UNRESOLVED_MESSAGE }
    ])
  })
})

describe('STA-4343 minimal guard: ordinary single-host cleanup still deletes', () => {
  it('deletes the confirmed local workspace for real', async () => {
    const hosts = createHostDirectories()
    const routedHostIds: string[] = []
    installRemovalTransport({ [HOST_A_HOST_ID]: hosts.hostARoot }, routedHostIds)
    const hostACandidate = makeHostCandidate(HOST_A_HOST_ID)
    seedScan([hostACandidate])

    const store = createTestStore()
    seedStore(store, {
      worktreesByRepo: {
        repo1: [
          makeWorktree({
            id: WORKTREE_ID,
            repoId: 'repo1',
            path: WORKTREE_PATH,
            hostId: HOST_A_HOST_ID
          })
        ]
      }
    } as Partial<AppState>)

    const removal = await store
      .getState()
      .removeWorkspaceCleanupCandidates([WORKTREE_ID], { approvedCandidates: [hostACandidate] })

    expect(removal.failures).toEqual([])
    expect(removal.removedIds).toEqual([WORKTREE_ID])
    expect(routedHostIds).toEqual([HOST_A_HOST_ID])
    expect(fs.existsSync(hosts.hostAMarkerPath)).toBe(false)
  })

  it('deletes the confirmed SSH workspace for real', async () => {
    const hosts = createHostDirectories()
    const routedHostIds: string[] = []
    installRemovalTransport({ [HOST_B_HOST_ID]: hosts.hostBRoot }, routedHostIds)
    const hostBCandidate = makeHostCandidate(HOST_B_HOST_ID)
    seedScan([hostBCandidate])

    const store = createTestStore()
    seedStore(store, {
      worktreesByRepo: {
        repo1: [
          makeWorktree({
            id: WORKTREE_ID,
            repoId: 'repo1',
            path: WORKTREE_PATH,
            hostId: HOST_B_HOST_ID
          })
        ]
      }
    } as Partial<AppState>)

    const removal = await store
      .getState()
      .removeWorkspaceCleanupCandidates([WORKTREE_ID], { approvedCandidates: [hostBCandidate] })

    expect(removal.failures).toEqual([])
    expect(removal.removedIds).toEqual([WORKTREE_ID])
    expect(routedHostIds).toEqual([HOST_B_HOST_ID])
    expect(fs.existsSync(hosts.hostBMarkerPath)).toBe(false)
  })

  it('deletes a host-qualified snapshot row after the refreshed owner matches', async () => {
    const hosts = createHostDirectories()
    const routedHostIds: string[] = []
    installRemovalTransport({ [HOST_A_HOST_ID]: hosts.hostARoot }, routedHostIds)
    const snapshotCandidate = makeHostCandidate(HOST_A_HOST_ID)
    seedScan([makeHostCandidate(HOST_A_HOST_ID)])

    const store = createTestStore()
    seedStore(store, {
      worktreesByRepo: {
        repo1: [
          makeWorktree({
            id: WORKTREE_ID,
            repoId: 'repo1',
            path: WORKTREE_PATH,
            hostId: HOST_A_HOST_ID
          })
        ]
      }
    } as Partial<AppState>)

    const removal = await store.getState().removeWorkspaceCleanupCandidates([WORKTREE_ID], {
      approvedCandidates: [snapshotCandidate]
    })

    expect(removal.failures).toEqual([])
    expect(removal.removedIds).toEqual([WORKTREE_ID])
    expect(routedHostIds).toEqual([HOST_A_HOST_ID])
    expect(fs.existsSync(hosts.hostAMarkerPath)).toBe(false)
  })
})
