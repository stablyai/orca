/**
 * STA-4343: workspace cleanup deletes on the host whose row was confirmed, and
 * only on that host.
 *
 * Two hosts can expose cleanup candidates with the SAME `repoId::path` identity
 * (the scan composes `worktreeId` from `repo.id` + `::` + the workspace path with
 * no host component). Selection, confirmation and preflight all keyed on
 * `worktreeId` alone, and removal routing prefers the ACTIVE workspace's host, so
 * confirming host B's row issued the destructive IPC against host A and destroyed
 * host A's real directory (and its uncommitted work).
 *
 * The same repo at the same path on two hosts is TWO workspaces, so the fix is to
 * ROUTE: the confirmed row names its host, and the removal lands there. #14731's
 * blanket refusal was the interim behavior this replaces. A refusal now means the
 * confirmed row itself cannot be attributed — no host evidence at all, or a
 * refreshed scan that no longer shows that host's row.
 *
 * Rig: two REAL temp directories stand in for the two hosts. The removal boundary
 * (`window.api.worktrees.remove`) is the only fake, and it ACTUALLY deletes the
 * directory on the host it is routed to. The gate is filesystem state, not
 * arguments — each assertion names which directory had to survive and which had
 * to go, so neither a rig that deletes nothing nor one that deletes everything
 * can pass.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ExecutionHostId } from '../../../../shared/execution-host'

const NOW = 1_700_000_000_000
const HOST_A_HOST_ID: ExecutionHostId = 'local'
const HOST_B_HOST_ID: ExecutionHostId = 'ssh:ssh-1'
const HOST_UNRESOLVED_MESSAGE =
  'Orca cannot tell which host owns this workspace. Refresh projects and review it again.'
const WORKSPACE_GONE_MESSAGE = 'Workspace no longer exists.'

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

/**
 * `force` here is the real thing, not a flag: a dirty worktree makes
 * shouldForceWorkspaceCleanupRemoval true, which is what the cleanup slice reads.
 * Force is the least re-checked destructive path, so every routing claim has to
 * hold on it too.
 */
function makeHostCandidate(
  executionHostId: ExecutionHostId | undefined,
  connectionId: string | null = executionHostId === HOST_B_HOST_ID ? 'ssh-1' : null,
  worktreeId = WORKTREE_ID,
  force = false
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
    blockers: force ? ['dirty-files'] : [],
    lastActivityAt: NOW - 30 * 24 * 60 * 60 * 1000,
    localContext: {
      terminalTabCount: 0,
      cleanEditorTabCount: 0,
      browserTabCount: 0,
      diffCommentCount: 0,
      newestDiffCommentAt: null,
      retainedDoneAgentCount: 0
    },
    git: { clean: !force, upstreamAhead: 0, upstreamBehind: 0, checkedAt: NOW },
    fingerprint: `fingerprint-${executionHostId ?? 'unqualified'}${force ? '-force' : ''}`
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
  routedHostIds: string[],
  routedForce?: boolean[]
): void {
  mockApi.worktrees.remove.mockImplementation(
    async (args: { worktreeId: string; hostId?: string; force?: boolean }) => {
      routedHostIds.push(args.hostId ?? '<missing>')
      routedForce?.push(args.force === true)
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

describe('STA-4343: cleanup deletes on the confirmed host, never the active one', () => {
  it('confirming host B deletes host B and leaves ACTIVE host A intact', async () => {
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
    // The confirmed row IS a workspace of its own, so it is deleted for real.
    expect(
      fs.existsSync(hosts.hostBMarkerPath),
      "HOST B's directory must be gone — its row is what the user confirmed"
    ).toBe(false)
    expect(routedHostIds).toEqual([HOST_B_HOST_ID])
    expect(removal.removedIds).toEqual([WORKTREE_ID])
    expect(removal.failures).toEqual([])
    // Host A's tabs belong to the workspace that survived, so they stay.
    expect(store.getState().tabsByWorktree[WORKTREE_ID]).toEqual([
      expect.objectContaining({ id: 'host-a-tab' })
    ])
  })

  it('refuses a row whose confirmed host no longer appears in the refreshed scan', async () => {
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
    expect(fs.existsSync(hosts.hostBMarkerPath), 'host B must survive').toBe(true)
    expect(routedHostIds).toEqual([])
    // The confirmed host's row is simply not there any more; do not fall through
    // to another host's row, which would decide force/blockers for a workspace
    // it does not own.
    expect(removal.failures).toEqual([
      {
        worktreeId: WORKTREE_ID,
        executionHostId: HOST_B_HOST_ID,
        displayName: 'shared-workspace',
        message: WORKSPACE_GONE_MESSAGE
      }
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

  it('keeps routing to the confirmed host after an earlier removal changes the active one', async () => {
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
        if (args[0].id === FIRST_WORKTREE_ID) {
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

    // Both rows were confirmed on host A, so host A's becoming inactive mid-batch
    // must not redirect the second removal onto whichever host is active now.
    expect(fs.existsSync(hosts.hostBMarkerPath), 'newly active host B must survive').toBe(true)
    expect(fs.existsSync(hosts.hostAMarkerPath), "confirmed host A's row must be gone").toBe(false)
    expect(routedHostIds).toEqual([HOST_A_HOST_ID, HOST_A_HOST_ID])
    expect(removal.removedIds).toEqual([FIRST_WORKTREE_ID, WORKTREE_ID])
    expect(removal.failures).toEqual([])
  })
})

describe.each([
  { label: 'normal', force: false },
  { label: 'force', force: true }
])('STA-4343: confirmed-host routing holds under $label removal', ({ force }) => {
  it('deletes the confirmed remote row while the ACTIVE local one survives', async () => {
    const hosts = createHostDirectories()
    const routedHostIds: string[] = []
    const routedForce: boolean[] = []
    installRemovalTransport(
      { [HOST_A_HOST_ID]: hosts.hostARoot, [HOST_B_HOST_ID]: hosts.hostBRoot },
      routedHostIds,
      routedForce
    )
    const hostBCandidate = makeHostCandidate(HOST_B_HOST_ID, undefined, WORKTREE_ID, force)
    seedScan([makeHostCandidate(HOST_A_HOST_ID, undefined, WORKTREE_ID, force), hostBCandidate])

    const store = createTestStore()
    seedStore(store, {
      // The ACTIVE workspace is host A's, so routing prefers host A on its own.
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
      }
    } as Partial<AppState>)

    const removal = await store
      .getState()
      .removeWorkspaceCleanupCandidates([WORKTREE_ID], { approvedCandidates: [hostBCandidate] })

    expect(removal.failures).toEqual([])
    expect(removal.removedIds).toEqual([WORKTREE_ID])
    expect(routedHostIds).toEqual([HOST_B_HOST_ID])
    expect(routedForce).toEqual([force])
    expect(fs.existsSync(hosts.hostBMarkerPath), 'confirmed host B must be gone').toBe(false)
    expect(fs.existsSync(hosts.hostAMarkerPath), 'ACTIVE host A must survive').toBe(true)
  })

  // NO FALSE REFUSALS: the guard must not turn an ordinary one-host delete into
  // an error, force included.
  it('still deletes an ordinary single-host workspace', async () => {
    const hosts = createHostDirectories()
    const routedHostIds: string[] = []
    const routedForce: boolean[] = []
    installRemovalTransport({ [HOST_A_HOST_ID]: hosts.hostARoot }, routedHostIds, routedForce)
    const candidate = makeHostCandidate(HOST_A_HOST_ID, undefined, WORKTREE_ID, force)
    seedScan([candidate])

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
      .removeWorkspaceCleanupCandidates([WORKTREE_ID], { approvedCandidates: [candidate] })

    expect(removal.failures).toEqual([])
    expect(removal.removedIds).toEqual([WORKTREE_ID])
    expect(routedForce).toEqual([force])
    expect(fs.existsSync(hosts.hostAMarkerPath)).toBe(false)
  })
})

describe('STA-4343: ordinary single-host cleanup still deletes', () => {
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
