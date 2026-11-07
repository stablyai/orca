import type * as RuntimeRpcCallModule from '@/runtime/rpc/calls/runtime-rpc-call'
/** Cleanup must delete the confirmed host’s same-ID workspace (STA-4343). Transport fakes delete real per-host directories; assert one survives and one is gone across local/SSH/runtime and active-host controls so inert or indiscriminate deletion cannot pass. */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ExecutionHostId } from '../../../../../shared/execution-host'

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

vi.mock('@/runtime/rpc/calls/runtime-rpc-call', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeRpcCallModule>()),
  callRuntimeRpc: runtimeRpc.callRuntimeRpc
}))

import { createTestStore, seedStore } from '../../testing/app-store-test-fixture'
import { makeTab } from '../../terminals/terminal-tab.test-fixture'
import { makeWorktree } from '../worktrees/worktree.test-fixture'
import { resetAuthoritativelyRemovedWorktreeMemoryForTests } from '../worktrees/listing/authoritative-worktree-removal-memory'
import type { AppState } from '../../types'
import type {
  WorkspaceCleanupCandidate,
  WorkspaceCleanupScanResult
} from '../../../../../shared/workspace-cleanup/workspace-cleanup'
import { getWorkspaceCleanupCandidateIdentity } from '../../../../../shared/workspace-cleanup/workspace-cleanup-host-identity'
import type { DetectedWorktree, Worktree } from '../../../../../shared/worktree/types'

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
})

describe('STA-4343 wrong-host cleanup removal (paired runtime host)', () => {
  // Older paired hosts may discard hostId and delete another same-ID owner; refuse collisions until capability proves host-qualified routing.
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
