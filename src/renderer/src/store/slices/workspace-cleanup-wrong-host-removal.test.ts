/**
 * STA-4343: workspace cleanup must delete on the host whose row was confirmed.
 *
 * Two hosts can expose cleanup candidates with the SAME `repoId::path` identity
 * (the scan composes `worktreeId` from `repo.id` + `::` + the workspace path
 * with no host component). Before the fix, selection, confirmation, preflight
 * and removal kept only `worktreeId` and removal routing preferred the ACTIVE
 * workspace's host, so confirming host B's row issued the destructive IPC
 * against host A and destroyed host A's real directory (and uncommitted work).
 *
 * Rig: two REAL temp directories stand in for the two hosts. The removal
 * boundary (`window.api.worktrees.remove` for the local/SSH transport,
 * `callRuntimeRpc('worktree.rm')` for a paired runtime) is the only fake, and
 * it ACTUALLY deletes the directory on the host it is routed to. The gate is
 * filesystem state, not arguments: after confirming host B's row, host A's
 * marker must still exist and host B's must be gone.
 *
 * The soundness controls matter as much as the wrong-host cases: the same rig
 * with host B ACTIVE (and with host A confirmed) still deletes exactly the
 * confirmed row, so a passing assertion cannot come from a rig that never
 * deletes anything.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type * as RuntimeRpcClientModule from '@/runtime/runtime-rpc-client'

const NOW = 1_700_000_000_000
const HOST_A_HOST_ID: ExecutionHostId = 'local'
const HOST_B_HOST_ID: ExecutionHostId = 'ssh:ssh-1'
const HOST_B_RUNTIME_HOST_ID: ExecutionHostId = 'runtime:hub-1'

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

const runtimeRpc = vi.hoisted(() => ({ callRuntimeRpc: vi.fn() }))

vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeRpcClientModule>()),
  callRuntimeRpc: runtimeRpc.callRuntimeRpc
}))

import { createTestStore, seedStore, makeTab, makeWorktree } from './store-test-helpers'
import { resetAuthoritativelyRemovedWorktreeMemoryForTests } from './worktrees'
import type { AppState } from '../types'
import type {
  WorkspaceCleanupCandidate,
  WorkspaceCleanupScanResult
} from '../../../../shared/workspace-cleanup'
import { getWorkspaceCleanupCandidateIdentity } from '../../../../shared/workspace-cleanup-host-identity'
import type { DetectedWorktree, Worktree } from '../../../../shared/worktree/types'

function makeDetectedWorktree(
  overrides: Partial<Worktree> & { id: string; repoId: string }
): DetectedWorktree {
  return {
    ...makeWorktree(overrides),
    ownership: 'orca-managed',
    selectedCheckout: false,
    visible: true
  }
}

function makeHostCandidate(
  worktreeId: string,
  executionHostId: ExecutionHostId | undefined,
  worktreePath: string,
  connectionId: string | null = executionHostId === HOST_B_HOST_ID ? 'ssh-1' : null
): WorkspaceCleanupCandidate {
  return {
    worktreeId,
    repoId: 'repo1',
    repoName: 'Repo 1',
    connectionId,
    ...(executionHostId ? { executionHostId } : {}),
    displayName: 'shared-workspace',
    branch: 'old-branch',
    path: worktreePath,
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
    git: {
      clean: true,
      upstreamAhead: 0,
      upstreamBehind: 0,
      checkedAt: NOW
    },
    fingerprint: `fingerprint-${executionHostId ?? 'unqualified'}`
  }
}

function parseIdentityPath(worktreeId: string): string {
  const separatorIndex = worktreeId.indexOf('::')
  return worktreeId.slice(separatorIndex + 2)
}

/** Maps a workspace id onto a per-host temp directory; Windows ids keep their shape. */
function toHostRelativePath(worktreeId: string): string {
  return parseIdentityPath(worktreeId)
    .replace(/^[a-zA-Z]:/, '')
    .split(/[/\\]+/)
    .filter((segment) => segment.length > 0)
    .join(path.sep)
}

type HostDirectories = {
  hostARoot: string
  hostBRoot: string
  hostAMarkerPath: string
  hostBMarkerPath: string
}

const hostDirCleanup: (() => void)[] = []

function createHostDirectories(worktreeId: string): HostDirectories {
  const hostARoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sta4343-host-a-'))
  const hostBRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sta4343-host-b-'))
  hostDirCleanup.push(() => {
    fs.rmSync(hostARoot, { recursive: true, force: true })
    fs.rmSync(hostBRoot, { recursive: true, force: true })
  })
  const relativePath = toHostRelativePath(worktreeId)
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

function parseRuntimeSelector(selector: string): string {
  return selector.startsWith('id:') ? selector.slice('id:'.length) : selector
}

/** Deletes for real on whichever host the removal is routed to. */
function installRemovalTransports(
  hostRootsByHostId: Record<string, string>,
  routedHostIds: string[],
  options: { preservedBranch?: { branchName: string; head: string } } = {}
): void {
  const deleteOnHost = (hostId: string | undefined, worktreeId: string): void => {
    routedHostIds.push(hostId ?? '<missing>')
    const hostRoot = hostId ? hostRootsByHostId[hostId] : undefined
    if (hostRoot) {
      fs.rmSync(path.join(hostRoot, toHostRelativePath(worktreeId)), {
        recursive: true,
        force: true
      })
    }
  }
  mockApi.worktrees.remove.mockImplementation(
    async (args: { worktreeId: string; hostId?: string }) => {
      deleteOnHost(args.hostId, args.worktreeId)
      return options.preservedBranch ? { preservedBranch: options.preservedBranch } : { ok: true }
    }
  )
  runtimeRpc.callRuntimeRpc.mockImplementation(
    async (_target: unknown, method: string, params: { hostId?: string; worktree?: string }) => {
      if (method !== 'worktree.rm') {
        return { hasHooks: false, hooks: null, mayNeedUpdate: false }
      }
      deleteOnHost(params.hostId, parseRuntimeSelector(params.worktree ?? ''))
      return { removed: true }
    }
  )
}

function seedCollidingScan(candidates: readonly WorkspaceCleanupCandidate[]): void {
  mockApi.workspaceCleanup.scan.mockResolvedValue({
    scannedAt: NOW,
    candidates: [...candidates],
    errors: []
  } satisfies WorkspaceCleanupScanResult)
}

beforeEach(() => {
  resetAuthoritativelyRemovedWorktreeMemoryForTests()
  mockApi.ephemeralVm.listRuntimes.mockResolvedValue([])
  mockApi.ephemeralVm.cleanup.mockResolvedValue({})
})

afterEach(() => {
  vi.clearAllMocks()
  for (const cleanup of hostDirCleanup.splice(0)) {
    cleanup()
  }
})

describe('STA-4343 wrong-host cleanup removal (git worktree identity)', () => {
  it('tears down only the confirmed host VM when another VM owns the same id', async () => {
    const worktreeId = 'repo1::/shared/workspace/path'
    const worktreePath = '/shared/workspace/path'
    const hostA: ExecutionHostId = 'ssh:runtime-ssh-a'
    const hostB: ExecutionHostId = 'ssh:runtime-ssh-b'
    const hosts = createHostDirectories(worktreeId)
    installRemovalTransports({ [hostA]: hosts.hostARoot, [hostB]: hosts.hostBRoot }, [])
    mockApi.ephemeralVm.listRuntimes.mockResolvedValue([
      {
        id: 'runtime-a',
        workspaceId: worktreeId,
        sshTargetId: 'runtime-ssh-a',
        cleanupStatus: 'not_started'
      },
      {
        id: 'runtime-b',
        workspaceId: worktreeId,
        sshTargetId: 'runtime-ssh-b',
        cleanupStatus: 'not_started'
      }
    ])
    const hostBCandidate = makeHostCandidate(worktreeId, hostB, worktreePath, 'runtime-ssh-b')
    seedCollidingScan([
      makeHostCandidate(worktreeId, hostA, worktreePath, 'runtime-ssh-a'),
      hostBCandidate
    ])
    const store = createTestStore()
    seedStore(store, {
      worktreesByRepo: {
        repo1: [
          makeWorktree({ id: worktreeId, repoId: 'repo1', path: worktreePath, hostId: hostA }),
          makeWorktree({ id: worktreeId, repoId: 'repo1', path: worktreePath, hostId: hostB })
        ]
      }
    } as Partial<AppState>)

    const removal = await store
      .getState()
      .removeWorkspaceCleanupCandidates([worktreeId], { approvedCandidates: [hostBCandidate] })

    expect(removal.failures).toEqual([])
    expect(mockApi.ephemeralVm.cleanup).toHaveBeenCalledTimes(1)
    expect(mockApi.ephemeralVm.cleanup).toHaveBeenCalledWith({ runtimeId: 'runtime-b' })
  })

  it('confirming host B row deletes host B and leaves ACTIVE host A intact', async () => {
    const worktreeId = 'repo1::/shared/workspace/path'
    const worktreePath = '/shared/workspace/path'
    const hosts = createHostDirectories(worktreeId)
    const routedHostIds: string[] = []
    installRemovalTransports(
      { [HOST_A_HOST_ID]: hosts.hostARoot, [HOST_B_HOST_ID]: hosts.hostBRoot },
      routedHostIds
    )
    const hostBCandidate = makeHostCandidate(worktreeId, HOST_B_HOST_ID, worktreePath)
    seedCollidingScan([makeHostCandidate(worktreeId, HOST_A_HOST_ID, worktreePath), hostBCandidate])

    const store = createTestStore()
    // Host A owns the ACTIVE workspace, so removal routing used to prefer host A.
    seedStore(store, {
      activeWorktreeId: worktreeId,
      activeWorkspaceExecutionHostId: HOST_A_HOST_ID,
      worktreesByRepo: {
        repo1: [
          makeWorktree({
            id: worktreeId,
            repoId: 'repo1',
            path: worktreePath,
            hostId: HOST_A_HOST_ID
          }),
          makeWorktree({
            id: worktreeId,
            repoId: 'repo1',
            path: worktreePath,
            hostId: HOST_B_HOST_ID
          })
        ]
      },
      detectedWorktreesByRepo: {
        repo1: {
          repoId: 'repo1',
          authoritative: true,
          source: 'git',
          worktrees: [
            makeDetectedWorktree({
              id: worktreeId,
              repoId: 'repo1',
              path: worktreePath,
              hostId: HOST_A_HOST_ID
            }),
            makeDetectedWorktree({
              id: worktreeId,
              repoId: 'repo1',
              path: worktreePath,
              hostId: HOST_B_HOST_ID
            })
          ]
        }
      },
      tabsByWorktree: {
        [worktreeId]: [makeTab({ id: 'host-a-tab', worktreeId })]
      }
    } as Partial<AppState>)

    // The user confirms HOST B's cleanup row.
    const removal = await store
      .getState()
      .removeWorkspaceCleanupCandidates([worktreeId], { approvedCandidates: [hostBCandidate] })

    expect(removal.removedIds).toEqual([worktreeId])
    expect(removal.failures).toEqual([])
    expect(
      fs.existsSync(hosts.hostAMarkerPath),
      `HOST A (active) worktree directory must still exist after confirming HOST B's row. worktrees.remove was routed to hostId=${routedHostIds.join(',')}`
    ).toBe(true)
    expect(
      fs.existsSync(hosts.hostBMarkerPath),
      'HOST B (confirmed) worktree directory must be gone'
    ).toBe(false)
    expect(routedHostIds).toEqual([HOST_B_HOST_ID])
    expect(store.getState().worktreesByRepo.repo1).toEqual([
      expect.objectContaining({ id: worktreeId, hostId: HOST_A_HOST_ID })
    ])
    expect(store.getState().tabsByWorktree[worktreeId]).toEqual([
      expect.objectContaining({ id: 'host-a-tab' })
    ])
    expect(store.getState().activeWorktreeId).toBe(worktreeId)
  })

  it('preserves a same-id host row published while removal is in flight', async () => {
    const worktreeId = 'repo1::/shared/workspace/path'
    const worktreePath = '/shared/workspace/path'
    const original = makeWorktree({
      id: worktreeId,
      repoId: 'repo1',
      path: worktreePath,
      hostId: HOST_A_HOST_ID
    })
    const arriving = makeWorktree({
      id: worktreeId,
      repoId: 'repo1',
      path: worktreePath,
      hostId: HOST_B_HOST_ID
    })
    const store = createTestStore()
    seedStore(store, {
      worktreesByRepo: { repo1: [original] },
      detectedWorktreesByRepo: {
        repo1: {
          repoId: 'repo1',
          authoritative: true,
          source: 'git',
          worktrees: [makeDetectedWorktree(original)]
        }
      },
      tabsByWorktree: {
        [worktreeId]: [makeTab({ id: 'arriving-host-tab', worktreeId })]
      }
    } as Partial<AppState>)
    mockApi.worktrees.remove.mockImplementationOnce(async () => {
      store.setState({
        worktreesByRepo: { repo1: [original, arriving] },
        detectedWorktreesByRepo: {
          repo1: {
            repoId: 'repo1',
            authoritative: true,
            source: 'git',
            worktrees: [makeDetectedWorktree(original), makeDetectedWorktree(arriving)]
          }
        }
      })
      return { ok: true }
    })

    const result = await store
      .getState()
      .removeWorktree({ id: worktreeId, executionHostId: HOST_A_HOST_ID })

    expect(result).toEqual({ ok: true })
    expect(store.getState().worktreesByRepo.repo1).toEqual([arriving])
    expect(store.getState().tabsByWorktree[worktreeId]).toEqual([
      expect.objectContaining({ id: 'arriving-host-tab' })
    ])
  })

  it('soundness control: with host B ACTIVE, confirming host B still deletes only host B', async () => {
    const worktreeId = 'repo1::/shared/workspace/path'
    const worktreePath = '/shared/workspace/path'
    const hosts = createHostDirectories(worktreeId)
    const routedHostIds: string[] = []
    installRemovalTransports(
      { [HOST_A_HOST_ID]: hosts.hostARoot, [HOST_B_HOST_ID]: hosts.hostBRoot },
      routedHostIds
    )
    const hostBCandidate = makeHostCandidate(worktreeId, HOST_B_HOST_ID, worktreePath)
    seedCollidingScan([makeHostCandidate(worktreeId, HOST_A_HOST_ID, worktreePath), hostBCandidate])

    const store = createTestStore()
    seedStore(store, {
      activeWorktreeId: worktreeId,
      activeWorkspaceExecutionHostId: HOST_B_HOST_ID
    } as Partial<AppState>)

    const removal = await store
      .getState()
      .removeWorkspaceCleanupCandidates([worktreeId], { approvedCandidates: [hostBCandidate] })

    expect(removal.failures).toEqual([])
    expect(fs.existsSync(hosts.hostBMarkerPath)).toBe(false)
    expect(fs.existsSync(hosts.hostAMarkerPath), 'host A must survive').toBe(true)
    expect(routedHostIds).toEqual([HOST_B_HOST_ID])
    expect(store.getState().activeWorktreeId).toBe(worktreeId)
    expect(store.getState().activeWorkspaceExecutionHostId).toBe(HOST_A_HOST_ID)
  })

  it('soundness control: confirming ACTIVE host A deletes host A and leaves host B intact', async () => {
    const worktreeId = 'repo1::/shared/workspace/path'
    const worktreePath = '/shared/workspace/path'
    const hosts = createHostDirectories(worktreeId)
    const routedHostIds: string[] = []
    installRemovalTransports(
      { [HOST_A_HOST_ID]: hosts.hostARoot, [HOST_B_HOST_ID]: hosts.hostBRoot },
      routedHostIds
    )
    const hostACandidate = makeHostCandidate(worktreeId, HOST_A_HOST_ID, worktreePath)
    seedCollidingScan([hostACandidate, makeHostCandidate(worktreeId, HOST_B_HOST_ID, worktreePath)])

    const store = createTestStore()
    seedStore(store, {
      activeWorktreeId: worktreeId,
      activeWorkspaceExecutionHostId: HOST_A_HOST_ID,
      worktreesByRepo: {
        repo1: [
          makeWorktree({
            id: worktreeId,
            repoId: 'repo1',
            path: worktreePath,
            hostId: HOST_A_HOST_ID
          })
        ]
      }
    } as Partial<AppState>)

    const removal = await store
      .getState()
      .removeWorkspaceCleanupCandidates([worktreeId], { approvedCandidates: [hostACandidate] })

    expect(removal.failures).toEqual([])
    expect(fs.existsSync(hosts.hostAMarkerPath)).toBe(false)
    expect(fs.existsSync(hosts.hostBMarkerPath), 'host B must survive').toBe(true)
    expect(routedHostIds).toEqual([HOST_A_HOST_ID])
    expect(store.getState().activeWorktreeId).toBe(worktreeId)
    expect(store.getState().activeWorkspaceExecutionHostId).toBe(HOST_B_HOST_ID)
  })

  it('tears down shared state when cleanup confirms both same-id host rows', async () => {
    const worktreeId = 'repo1::/shared/workspace/path'
    const worktreePath = '/shared/workspace/path'
    const hosts = createHostDirectories(worktreeId)
    const routedHostIds: string[] = []
    installRemovalTransports(
      { [HOST_A_HOST_ID]: hosts.hostARoot, [HOST_B_HOST_ID]: hosts.hostBRoot },
      routedHostIds
    )
    const hostACandidate = makeHostCandidate(worktreeId, HOST_A_HOST_ID, worktreePath)
    const hostBCandidate = makeHostCandidate(worktreeId, HOST_B_HOST_ID, worktreePath)
    seedCollidingScan([hostACandidate, hostBCandidate])

    const store = createTestStore()
    seedStore(store, {
      activeWorktreeId: worktreeId,
      activeWorkspaceExecutionHostId: HOST_A_HOST_ID,
      worktreesByRepo: {
        repo1: [
          makeWorktree({
            id: worktreeId,
            repoId: 'repo1',
            path: worktreePath,
            hostId: HOST_A_HOST_ID
          }),
          makeWorktree({
            id: worktreeId,
            repoId: 'repo1',
            path: worktreePath,
            hostId: HOST_B_HOST_ID
          })
        ]
      },
      detectedWorktreesByRepo: {
        repo1: {
          repoId: 'repo1',
          authoritative: true,
          source: 'git',
          worktrees: [
            makeDetectedWorktree({
              id: worktreeId,
              repoId: 'repo1',
              path: worktreePath,
              hostId: HOST_A_HOST_ID
            }),
            makeDetectedWorktree({
              id: worktreeId,
              repoId: 'repo1',
              path: worktreePath,
              hostId: HOST_B_HOST_ID
            })
          ]
        }
      },
      workspaceCleanupScan: {
        scannedAt: NOW,
        candidates: [hostACandidate, hostBCandidate],
        errors: []
      },
      tabsByWorktree: { [worktreeId]: [makeTab({ id: 'shared-tab', worktreeId })] }
    } as Partial<AppState>)

    const removal = await store
      .getState()
      .removeWorkspaceCleanupCandidates([worktreeId, worktreeId], {
        approvedCandidates: [hostACandidate, hostBCandidate]
      })

    expect(removal.failures).toEqual([])
    expect(removal.removedIdentities).toEqual([
      getWorkspaceCleanupCandidateIdentity(hostACandidate),
      getWorkspaceCleanupCandidateIdentity(hostBCandidate)
    ])
    expect(new Set(routedHostIds)).toEqual(new Set([HOST_A_HOST_ID, HOST_B_HOST_ID]))
    expect(fs.existsSync(hosts.hostAMarkerPath)).toBe(false)
    expect(fs.existsSync(hosts.hostBMarkerPath)).toBe(false)
    expect(store.getState().tabsByWorktree[worktreeId]).toBeUndefined()
    expect(store.getState().activeWorktreeId).toBeNull()
  })

  it('keeps the confirmed host on the preserved-branch follow-up', async () => {
    const worktreeId = 'repo1::/shared/workspace/path'
    const worktreePath = '/shared/workspace/path'
    const hosts = createHostDirectories(worktreeId)
    const routedHostIds: string[] = []
    installRemovalTransports(
      { [HOST_A_HOST_ID]: hosts.hostARoot, [HOST_B_HOST_ID]: hosts.hostBRoot },
      routedHostIds,
      { preservedBranch: { branchName: 'feature/kept', head: 'abc123' } }
    )
    const hostBCandidate = makeHostCandidate(worktreeId, HOST_B_HOST_ID, worktreePath)
    seedCollidingScan([makeHostCandidate(worktreeId, HOST_A_HOST_ID, worktreePath), hostBCandidate])
    const store = createTestStore()
    seedStore(store, {
      activeWorktreeId: worktreeId,
      activeWorkspaceExecutionHostId: HOST_A_HOST_ID
    } as Partial<AppState>)

    const removal = await store
      .getState()
      .removeWorkspaceCleanupCandidates([worktreeId], { approvedCandidates: [hostBCandidate] })

    expect(removal.preservedBranches).toEqual([
      {
        worktreeId,
        branchName: 'feature/kept',
        expectedHead: 'abc123',
        hostId: HOST_B_HOST_ID
      }
    ])
  })

  it('routes a Windows-path colliding identity to the confirmed host', async () => {
    const worktreeId = 'repo1::C:\\Users\\me\\workspaces\\shared'
    const worktreePath = 'C:\\Users\\me\\workspaces\\shared'
    const hosts = createHostDirectories(worktreeId)
    const routedHostIds: string[] = []
    installRemovalTransports(
      { [HOST_A_HOST_ID]: hosts.hostARoot, [HOST_B_HOST_ID]: hosts.hostBRoot },
      routedHostIds
    )
    const hostBCandidate = makeHostCandidate(worktreeId, HOST_B_HOST_ID, worktreePath)
    seedCollidingScan([makeHostCandidate(worktreeId, HOST_A_HOST_ID, worktreePath), hostBCandidate])

    const store = createTestStore()
    seedStore(store, {
      activeWorktreeId: worktreeId,
      activeWorkspaceExecutionHostId: HOST_A_HOST_ID,
      worktreesByRepo: {
        repo1: [
          makeWorktree({
            id: worktreeId,
            repoId: 'repo1',
            path: worktreePath,
            hostId: HOST_A_HOST_ID
          })
        ]
      }
    } as Partial<AppState>)

    const removal = await store
      .getState()
      .removeWorkspaceCleanupCandidates([worktreeId], { approvedCandidates: [hostBCandidate] })

    expect(removal.failures).toEqual([])
    expect(fs.existsSync(hosts.hostAMarkerPath), 'host A (active) must survive').toBe(true)
    expect(fs.existsSync(hosts.hostBMarkerPath)).toBe(false)
    expect(routedHostIds).toEqual([HOST_B_HOST_ID])
  })
})

describe('STA-4343 wrong-host cleanup removal (folder workspace identity)', () => {
  it('folder workspace identity deletes the confirmed host, not the ACTIVE one', async () => {
    const worktreeId = 'repo1::/shared/folder-workspace'
    const worktreePath = '/shared/folder-workspace'
    const hosts = createHostDirectories(worktreeId)
    const routedHostIds: string[] = []
    installRemovalTransports(
      { [HOST_A_HOST_ID]: hosts.hostARoot, [HOST_B_HOST_ID]: hosts.hostBRoot },
      routedHostIds
    )
    const hostBCandidate = makeHostCandidate(worktreeId, HOST_B_HOST_ID, worktreePath)
    seedCollidingScan([makeHostCandidate(worktreeId, HOST_A_HOST_ID, worktreePath), hostBCandidate])

    const store = createTestStore()
    // Folder workspaces are not Git worktrees: no worktree owner rows exist.
    seedStore(store, {
      activeWorktreeId: worktreeId,
      activeWorkspaceExecutionHostId: HOST_A_HOST_ID,
      tabsByWorktree: {
        [worktreeId]: [makeTab({ id: 'host-a-folder-tab', worktreeId })]
      }
    } as Partial<AppState>)

    const removal = await store
      .getState()
      .removeWorkspaceCleanupCandidates([worktreeId], { approvedCandidates: [hostBCandidate] })

    expect(removal.removedIds).toEqual([worktreeId])
    expect(removal.failures).toEqual([])
    expect(
      fs.existsSync(hosts.hostAMarkerPath),
      `HOST A (active) folder workspace must still exist. worktrees.remove was routed to hostId=${routedHostIds.join(',')}`
    ).toBe(true)
    expect(fs.existsSync(hosts.hostBMarkerPath)).toBe(false)
    expect(routedHostIds).toEqual([HOST_B_HOST_ID])
    expect(store.getState().tabsByWorktree[worktreeId]).toEqual([
      expect.objectContaining({ id: 'host-a-folder-tab' })
    ])
    expect(store.getState().activeWorktreeId).toBe(worktreeId)
  })
})

describe('STA-4343 wrong-host cleanup removal (paired runtime host)', () => {
  it('confirming a paired runtime row deletes over the runtime RPC, not the local host', async () => {
    const worktreeId = 'repo1::/shared/workspace/path'
    const worktreePath = '/shared/workspace/path'
    const hosts = createHostDirectories(worktreeId)
    const routedHostIds: string[] = []
    installRemovalTransports(
      { [HOST_A_HOST_ID]: hosts.hostARoot, [HOST_B_RUNTIME_HOST_ID]: hosts.hostBRoot },
      routedHostIds
    )
    const hostBCandidate = makeHostCandidate(worktreeId, HOST_B_RUNTIME_HOST_ID, worktreePath, null)
    seedCollidingScan([makeHostCandidate(worktreeId, HOST_A_HOST_ID, worktreePath), hostBCandidate])

    const store = createTestStore()
    seedStore(store, {
      activeWorktreeId: worktreeId,
      activeWorkspaceExecutionHostId: HOST_A_HOST_ID,
      worktreesByRepo: {
        repo1: [
          makeWorktree({
            id: worktreeId,
            repoId: 'repo1',
            path: worktreePath,
            hostId: HOST_A_HOST_ID
          })
        ]
      }
    } as Partial<AppState>)

    const removal = await store
      .getState()
      .removeWorkspaceCleanupCandidates([worktreeId], { approvedCandidates: [hostBCandidate] })

    expect(removal.failures).toEqual([])
    expect(fs.existsSync(hosts.hostAMarkerPath), 'local host A must survive').toBe(true)
    expect(fs.existsSync(hosts.hostBMarkerPath)).toBe(false)
    expect(routedHostIds).toEqual([HOST_B_RUNTIME_HOST_ID])
    // The destructive call left over the paired transport, not the local IPC.
    expect(mockApi.worktrees.remove).not.toHaveBeenCalled()
    expect(runtimeRpc.callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'hub-1' },
      'worktree.rm',
      expect.objectContaining({ hostId: HOST_B_RUNTIME_HOST_ID }),
      expect.anything()
    )
  })

  // Why: routing depends on the HOST honouring `hostId`. Local main always does —
  // it ships with this renderer. A paired remote server may be an older build that
  // strips the field and routes by its own preference, which on a colliding id
  // deletes the wrong workspace. Fail closed there until a capability gate exists.
  it('refuses a colliding removal over the paired transport rather than trusting it', async () => {
    const worktreeId = 'repo1::/shared/workspace/path'
    const worktreePath = '/shared/workspace/path'
    const hosts = createHostDirectories(worktreeId)
    const routedHostIds: string[] = []
    installRemovalTransports(
      { [HOST_A_HOST_ID]: hosts.hostARoot, [HOST_B_RUNTIME_HOST_ID]: hosts.hostBRoot },
      routedHostIds
    )
    const hostBCandidate = makeHostCandidate(worktreeId, HOST_B_RUNTIME_HOST_ID, worktreePath, null)
    seedCollidingScan([makeHostCandidate(worktreeId, HOST_A_HOST_ID, worktreePath), hostBCandidate])

    const store = createTestStore()
    seedStore(store, {
      activeWorktreeId: worktreeId,
      activeWorkspaceExecutionHostId: HOST_A_HOST_ID,
      // BOTH owners visible to the client: this is the collision the remote host
      // would have to disambiguate from `hostId` alone.
      worktreesByRepo: {
        repo1: [
          makeWorktree({
            id: worktreeId,
            repoId: 'repo1',
            path: worktreePath,
            hostId: HOST_A_HOST_ID
          }),
          makeWorktree({
            id: worktreeId,
            repoId: 'repo1',
            path: worktreePath,
            hostId: HOST_B_RUNTIME_HOST_ID
          })
        ]
      }
    } as Partial<AppState>)

    const removal = await store
      .getState()
      .removeWorkspaceCleanupCandidates([worktreeId], { approvedCandidates: [hostBCandidate] })

    expect(removal.removedIds).toEqual([])
    expect(removal.failures[0]?.message).toContain('exists on multiple hosts')
    expect(routedHostIds).toEqual([])
    expect(fs.existsSync(hosts.hostAMarkerPath), 'local host A must survive').toBe(true)
    expect(fs.existsSync(hosts.hostBMarkerPath), 'runtime host B must survive').toBe(true)
  })
})

describe('STA-4343 cleanup removal fails closed on an unresolved owner', () => {
  it('deletes nothing when the confirmed host no longer lists the row', async () => {
    const worktreeId = 'repo1::/shared/workspace/path'
    const worktreePath = '/shared/workspace/path'
    const hosts = createHostDirectories(worktreeId)
    const routedHostIds: string[] = []
    installRemovalTransports(
      { [HOST_A_HOST_ID]: hosts.hostARoot, [HOST_B_HOST_ID]: hosts.hostBRoot },
      routedHostIds
    )
    const hostBCandidate = makeHostCandidate(worktreeId, HOST_B_HOST_ID, worktreePath)
    // The confirm-time list had both hosts; the preflight rescan sees only host A.
    seedCollidingScan([makeHostCandidate(worktreeId, HOST_A_HOST_ID, worktreePath)])

    const store = createTestStore()
    seedStore(store, {
      activeWorktreeId: worktreeId,
      activeWorkspaceExecutionHostId: HOST_A_HOST_ID
    } as Partial<AppState>)

    const removal = await store
      .getState()
      .removeWorkspaceCleanupCandidates([worktreeId], { approvedCandidates: [hostBCandidate] })

    expect(removal.removedIds).toEqual([])
    expect(removal.failures).toHaveLength(1)
    expect(fs.existsSync(hosts.hostAMarkerPath), 'host A must survive').toBe(true)
    expect(fs.existsSync(hosts.hostBMarkerPath), 'host B must survive').toBe(true)
    expect(routedHostIds).toEqual([])
  })

  it('deletes nothing for an unqualified row the store knows on two hosts', async () => {
    const worktreeId = 'repo1::/shared/workspace/path'
    const worktreePath = '/shared/workspace/path'
    const hosts = createHostDirectories(worktreeId)
    const routedHostIds: string[] = []
    installRemovalTransports(
      { [HOST_A_HOST_ID]: hosts.hostARoot, [HOST_B_HOST_ID]: hosts.hostBRoot },
      routedHostIds
    )
    // A row published before host-qualified candidates existed: no host evidence.
    const legacyCandidate = makeHostCandidate(worktreeId, undefined, worktreePath, null)
    seedCollidingScan([legacyCandidate])

    const store = createTestStore()
    seedStore(store, {
      worktreesByRepo: {
        repo1: [
          makeWorktree({
            id: worktreeId,
            repoId: 'repo1',
            path: worktreePath,
            hostId: HOST_A_HOST_ID
          }),
          makeWorktree({
            id: worktreeId,
            repoId: 'repo1',
            path: worktreePath,
            hostId: HOST_B_HOST_ID
          })
        ]
      }
    } as Partial<AppState>)

    const removal = await store
      .getState()
      .removeWorkspaceCleanupCandidates([worktreeId], { approvedCandidates: [legacyCandidate] })

    expect(removal.removedIds).toEqual([])
    expect(removal.failures).toHaveLength(1)
    expect(fs.existsSync(hosts.hostAMarkerPath), 'host A must survive').toBe(true)
    expect(fs.existsSync(hosts.hostBMarkerPath), 'host B must survive').toBe(true)
    expect(routedHostIds).toEqual([])
    expect(mockApi.worktrees.remove).not.toHaveBeenCalled()
    expect(runtimeRpc.callRuntimeRpc).not.toHaveBeenCalled()
  })

  it('deletes nothing for an old-client row with no host qualifier or catalog owner', async () => {
    const worktreeId = 'repo1::/shared/workspace/path'
    const worktreePath = '/shared/workspace/path'
    const hosts = createHostDirectories(worktreeId)
    const routedHostIds: string[] = []
    installRemovalTransports(
      { [HOST_A_HOST_ID]: hosts.hostARoot, [HOST_B_HOST_ID]: hosts.hostBRoot },
      routedHostIds
    )
    const legacyCandidate = makeHostCandidate(worktreeId, undefined, worktreePath, null)
    seedCollidingScan([legacyCandidate])

    const store = createTestStore()
    seedStore(store, {
      activeWorktreeId: worktreeId,
      activeWorkspaceExecutionHostId: HOST_A_HOST_ID
    } as Partial<AppState>)

    const removal = await store
      .getState()
      .removeWorkspaceCleanupCandidates([worktreeId], { approvedCandidates: [legacyCandidate] })

    expect(removal.removedIds).toEqual([])
    expect(removal.failures).toHaveLength(1)
    expect(fs.existsSync(hosts.hostAMarkerPath), 'host A must survive').toBe(true)
    expect(fs.existsSync(hosts.hostBMarkerPath), 'host B must survive').toBe(true)
    expect(routedHostIds).toEqual([])
    expect(mockApi.worktrees.remove).not.toHaveBeenCalled()
    expect(runtimeRpc.callRuntimeRpc).not.toHaveBeenCalled()
  })
})
