// @vitest-environment happy-dom

import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { GitStatusResult } from '../../../../shared/git-status-types'
import type { Repo } from '../../../../shared/repo-types'
import type { GitWorktreeInfo } from '../../../../shared/worktree/types'
import { getWorkspaceCleanupCandidateIdentity } from '../../../../shared/workspace-cleanup-host-identity'
import type {
  WorkspaceCleanupScanArgs,
  WorkspaceCleanupScanResult
} from '../../../../shared/workspace-cleanup'

const {
  listRepoWorktreesMock,
  getStatusMock,
  gitExecFileAsyncMock,
  getLocalProjectWorktreeGitOptionsMock,
  getSshGitProviderMock
} = vi.hoisted(() => ({
  listRepoWorktreesMock: vi.fn(),
  getStatusMock: vi.fn(),
  gitExecFileAsyncMock: vi.fn(),
  getLocalProjectWorktreeGitOptionsMock: vi.fn(),
  getSshGitProviderMock: vi.fn()
}))

vi.mock('../../../../main/repo-worktrees', () => ({
  listRepoWorktrees: listRepoWorktreesMock,
  createFolderWorktree: vi.fn()
}))
vi.mock('../../../../main/git/status', () => ({ getStatus: getStatusMock }))
vi.mock('../../../../main/git/runner', () => ({ gitExecFileAsync: gitExecFileAsyncMock }))
vi.mock('../../../../main/project-runtime-git-options', () => ({
  getLocalProjectWorktreeGitOptions: getLocalProjectWorktreeGitOptionsMock
}))
vi.mock('../../../../main/providers/ssh-git-dispatch', () => ({
  getSshGitProvider: getSshGitProviderMock
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }))

import { useAppStore } from '@/store'
import { makeWorktree } from '@/store/slices/store-test-helpers'
import { resetAuthoritativelyRemovedWorktreeMemoryForTests } from '@/store/slices/worktrees'
import { useWorkspaceCleanupRemoval } from './use-workspace-cleanup-removal'

const SSH_CONNECTION_ID = 'host-b'
const HOST_A_ID = 'local'
const HOST_B_ID = `ssh:${SSH_CONNECTION_ID}` as const
const REPO_ID = 'colliding-repo'
const DAY_MS = 24 * 60 * 60 * 1000
const SCANNER_MODULE_PATH = ['../../../../main/ipc/', 'workspace-cleanup-scan'].join('')
const initialState = useAppStore.getInitialState()
const temporaryRoots: string[] = []

type ScanWorkspaceCleanup = (
  store: unknown,
  args?: WorkspaceCleanupScanArgs
) => Promise<WorkspaceCleanupScanResult>

function makeRepo(overrides: Partial<Repo>): Repo {
  return {
    id: REPO_ID,
    path: '/repo',
    displayName: 'Colliding repo',
    badgeColor: '#000',
    addedAt: 0,
    ...overrides
  }
}

function toHostRelativePath(worktreeId: string): string {
  const workspacePath = worktreeId.slice(worktreeId.indexOf('::') + 2)
  return workspacePath
    .replace(/^[a-zA-Z]:/, '')
    .split(/[/\\]+/)
    .filter(Boolean)
    .join(path.sep)
}

function createMarker(root: string, worktreeId: string, name: string): string {
  const worktreePath = path.join(root, toHostRelativePath(worktreeId))
  fs.mkdirSync(worktreePath, { recursive: true })
  const markerPath = path.join(worktreePath, name)
  fs.writeFileSync(markerPath, name)
  return markerPath
}

describe('workspace cleanup scanned host confirmation removal', () => {
  beforeEach(() => {
    resetAuthoritativelyRemovedWorktreeMemoryForTests()
    getStatusMock.mockReset().mockResolvedValue({
      entries: [],
      conflictOperation: 'unknown',
      upstreamStatus: { hasUpstream: true, ahead: 0, behind: 0 }
    } satisfies GitStatusResult)
    gitExecFileAsyncMock.mockReset().mockResolvedValue({ stdout: '0\n', stderr: '' })
    getLocalProjectWorktreeGitOptionsMock.mockReset().mockReturnValue({})
  })

  afterEach(() => {
    useAppStore.setState(initialState, true)
    Reflect.deleteProperty(window, 'api')
    vi.clearAllMocks()
    for (const root of temporaryRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('deletes only host B after its real scanned candidate crosses the confirmation path', async () => {
    const scanRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-cleanup-scan-'))
    const hostARoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-cleanup-host-a-'))
    const hostBRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-cleanup-host-b-'))
    temporaryRoots.push(scanRoot, hostARoot, hostBRoot)
    const sharedPath = path.join(scanRoot, 'shared-workspace')
    const gitPath = path.join(sharedPath, '.git')
    fs.mkdirSync(gitPath, { recursive: true })
    const oldTime = new Date(Date.now() - 40 * DAY_MS)
    fs.utimesSync(sharedPath, oldTime, oldTime)
    fs.utimesSync(gitPath, oldTime, oldTime)
    const worktreeId = `${REPO_ID}::${sharedPath}`
    const hostAMarker = createMarker(hostARoot, worktreeId, 'HOST_A_MARKER')
    const hostBMarker = createMarker(hostBRoot, worktreeId, 'HOST_B_MARKER')
    const localRepo = makeRepo({ executionHostId: HOST_A_ID })
    const sshRepo = makeRepo({
      path: '/remote/repo',
      connectionId: SSH_CONNECTION_ID,
      executionHostId: HOST_B_ID
    })
    const gitWorktree: GitWorktreeInfo = {
      path: sharedPath,
      head: 'abc123',
      branch: 'refs/heads/shared-workspace',
      isBare: false,
      isMainWorktree: false
    }
    const sshProvider = {
      listWorktrees: vi.fn().mockResolvedValue([gitWorktree]),
      getStatus: vi.fn().mockResolvedValue({
        entries: [],
        conflictOperation: 'unknown',
        upstreamStatus: { hasUpstream: true, ahead: 0, behind: 0 }
      } satisfies GitStatusResult),
      exec: vi.fn().mockResolvedValue({ stdout: '0\n', stderr: '' })
    }
    listRepoWorktreesMock.mockResolvedValue([gitWorktree])
    getSshGitProviderMock.mockReturnValue(sshProvider)
    const scanStore = {
      getRepos: () => [localRepo, sshRepo],
      getWorktreeMeta: () => undefined,
      getAllWorktreeMeta: () => ({}),
      getGitHubCache: () => ({ pr: {}, issue: {} })
    }
    const { scanWorkspaceCleanup } = await vi.importActual<{
      scanWorkspaceCleanup: ScanWorkspaceCleanup
    }>(SCANNER_MODULE_PATH)
    const scan = vi.fn((args) => scanWorkspaceCleanup(scanStore, args))
    const routedHostIds: string[] = []
    const remove = vi.fn(async (args: { worktreeId: string; hostId?: string }) => {
      routedHostIds.push(args.hostId ?? '<missing>')
      const root =
        args.hostId === HOST_A_ID ? hostARoot : args.hostId === HOST_B_ID ? hostBRoot : null
      if (root) {
        fs.rmSync(path.join(root, toHostRelativePath(args.worktreeId)), {
          recursive: true,
          force: true
        })
      }
      return { ok: true as const }
    })
    Object.assign(window, {
      api: {
        worktrees: { remove, forgetLocal: vi.fn() },
        hooks: { check: vi.fn().mockResolvedValue({ hasHooks: false, hooks: null }) },
        workspaceCleanup: {
          scan,
          cancelScan: vi.fn().mockResolvedValue(undefined),
          dismiss: vi.fn().mockResolvedValue(undefined),
          clearDismissals: vi.fn().mockResolvedValue(undefined),
          recordRemovalSnapshotPrune: vi.fn().mockResolvedValue(undefined)
        },
        pty: { kill: vi.fn().mockResolvedValue(undefined) },
        runtimeEnvironments: { call: vi.fn() },
        ephemeralVm: { listRuntimes: vi.fn().mockResolvedValue([]), cleanup: vi.fn() }
      }
    })
    useAppStore.setState({
      repos: [localRepo, sshRepo],
      activeWorktreeId: worktreeId,
      activeWorkspaceExecutionHostId: HOST_A_ID,
      worktreesByRepo: {
        [REPO_ID]: [
          makeWorktree({ id: worktreeId, repoId: REPO_ID, path: sharedPath, hostId: HOST_A_ID }),
          makeWorktree({ id: worktreeId, repoId: REPO_ID, path: sharedPath, hostId: HOST_B_ID })
        ]
      }
    })

    expect(fs.existsSync(hostAMarker)).toBe(true)
    expect(fs.existsSync(hostBMarker)).toBe(true)
    const scanned = await useAppStore.getState().scanWorkspaceCleanup()
    const hostBCandidate = scanned.candidates.find(
      (candidate) => candidate.executionHostId === HOST_B_ID
    )
    expect(hostBCandidate).toMatchObject({ worktreeId, executionHostId: HOST_B_ID })
    expect(
      scanned.candidates.filter((candidate) => candidate.worktreeId === worktreeId)
    ).toHaveLength(2)
    const onDeselect = vi.fn()
    const removal = renderHook(() =>
      useWorkspaceCleanupRemoval({ onDeselect, closeModal: vi.fn() })
    )

    act(() => removal.result.current.openConfirmRemove([hostBCandidate!]))
    expect(removal.result.current.confirmCandidates[0]).toBe(hostBCandidate)
    act(() => removal.result.current.confirmRemove())
    await waitFor(() => expect(removal.result.current.removalInFlight).toBe(false))

    expect(fs.existsSync(hostAMarker), 'host A marker must survive host B confirmation').toBe(true)
    expect(fs.existsSync(hostBMarker), 'host B marker must be deleted').toBe(false)
    expect(routedHostIds).toEqual([HOST_B_ID])
    expect(remove).toHaveBeenCalledTimes(1)
    expect(scan).toHaveBeenCalledTimes(2)
    expect(scan.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ worktreeIds: [worktreeId], refreshActivity: true })
    )
    expect(onDeselect).toHaveBeenCalledWith([getWorkspaceCleanupCandidateIdentity(hostBCandidate!)])
  })
})
