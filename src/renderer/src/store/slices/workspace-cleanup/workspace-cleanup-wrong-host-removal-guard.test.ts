/** Route cleanup to the confirmed host, replacing #14731’s blanket refusal (STA-4343). Real per-host temp directories and destructive transport fakes prove exactly the confirmed copy is removed; neither deleting none nor deleting all can pass. */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'

const NOW = 1_700_000_000_000
const HOST_A_HOST_ID: ExecutionHostId = 'local'
const HOST_B_HOST_ID: ExecutionHostId = 'ssh:ssh-1'

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

import { createTestStore, seedStore } from '../../testing/app-store-test-fixture'
import { makeWorktree } from '../worktrees/worktree.test-fixture'
import { resetAuthoritativelyRemovedWorktreeMemoryForTests } from '../worktrees/listing/authoritative-worktree-removal-memory'
import type { AppState } from '../../types'
import type {
  WorkspaceCleanupCandidate,
  WorkspaceCleanupScanResult
} from '../../../../../shared/workspace-cleanup/workspace-cleanup'

const WORKTREE_ID = 'repo1::/shared/workspace/path'
const WORKTREE_PATH = '/shared/workspace/path'
const FIRST_WORKTREE_ID = 'repo1::/first/very-long-workspace/path'

/** Dirty candidates exercise actual force removal; owner routing must remain correct on that least-rechecked path. */
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
    reasons: ['inactive'],
    blockers: force ? ['dirty-files'] : [],
    lastActivityAt: NOW - 30 * 24 * 60 * 60 * 1000,
    localContext: {
      terminalTabCount: 0,
      cleanEditorTabCount: 0,
      browserTabCount: 0,
      diffCommentCount: 0,
      newestDiffCommentAt: null,
      finishedAgentCount: 0
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

    // Changing focus mid-batch must not retarget the second confirmed host-A removal.
    expect(fs.existsSync(hosts.hostBMarkerPath), 'newly active host B must survive').toBe(true)
    expect(fs.existsSync(hosts.hostAMarkerPath), "confirmed host A's row must be gone").toBe(false)
    expect(routedHostIds).toEqual([HOST_A_HOST_ID, HOST_A_HOST_ID])
    expect(removal.removedIds).toEqual([FIRST_WORKTREE_ID, WORKTREE_ID])
    expect(removal.failures).toEqual([])
  })
})

import '@/components/native-chat/drafts/native-chat-draft-reset'
import '@/components/native-chat/drafts/native-chat-launch-draft-source'
import '@/components/native-chat/drafts/native-chat-composer-draft-store'
import '@/components/native-chat/drafts/native-chat-composer-draft-load'
import '@/components/native-chat/drafts/native-chat-composer-draft-persistence'
import '@/components/native-chat/attachments/chips/native-chat-pending-attachment-cache'

import '@/components/native-chat/drafts/native-chat-composer-draft-storage'
