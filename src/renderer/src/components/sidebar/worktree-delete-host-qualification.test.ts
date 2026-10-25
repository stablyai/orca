/** Delete a confirmed SSH twin while its local twin is active; real transport fixtures remove only the routed host’s temp directory. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import type { AppState } from '@/store/types'
import type { Worktree } from '../../../../shared/worktree/types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import { makeTab } from '../../store/slices/store-session-test-harness'
import {
  createTestStore,
  mockApi,
  resetRemoteRuntimeMocks,
  resetWorktreeSliceModuleMemory,
  runtimeEnvironmentCall
} from '@/store/slices/worktrees-slice-test-harness'
import {
  cleanupHostCheckouts,
  createHostCheckout,
  installRemovalTransports,
  COLLIDING_WORKTREE_ID as WORKTREE_ID,
  COLLIDING_WORKTREE_PATH as WORKTREE_PATH,
  LOCAL_HOST,
  SSH_HOST
} from '@/store/slices/worktree-removal-host-collision-fixture'

const storeRef = vi.hoisted(() => ({ current: null as unknown as { getState: () => AppState } }))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => storeRef.current.getState()
  }
}))

vi.mock('sonner', () => ({
  toast: {
    warning: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    dismiss: vi.fn()
  }
}))

vi.mock('@/lib/worktree-activation', () => ({ activateAndRevealWorktree: vi.fn() }))

vi.mock('./delete-worktree-failure-toast', () => ({
  showDeleteWorktreeFailureToast: vi.fn()
}))

import { showDeleteWorktreeFailureToast } from './delete-worktree-failure-toast'
import { runWorktreeDelete, runWorktreeDeletesInParallel } from './delete-worktree-flow'

function failureToastCount(): number {
  return vi.mocked(showDeleteWorktreeFailureToast).mock.calls.length
}

function rowOnHost(hostId: ExecutionHostId): Worktree {
  return makeWorktree({
    id: WORKTREE_ID,
    repoId: 'repo1',
    path: WORKTREE_PATH,
    displayName: 'shared-workspace',
    instanceId: `instance-${hostId}`,
    hostId
  })
}

/** Seed the other host first so an ID-only lookup would target the wrong checkout. */
function seedCollidingSidebar(
  store: ReturnType<typeof createTestStore>,
  confirmedRowHostId: ExecutionHostId
): void {
  const otherHostId = confirmedRowHostId === LOCAL_HOST ? SSH_HOST : LOCAL_HOST
  store.setState({
    repos: [{ id: 'repo1', path: '/repo1', displayName: 'Repo 1', executionHostId: LOCAL_HOST }],
    worktreesByRepo: { repo1: [rowOnHost(otherHostId), rowOnHost(confirmedRowHostId)] },
    detectedWorktreesByRepo: {
      repo1: {
        repoId: 'repo1',
        authoritative: true,
        source: 'git',
        worktrees: [rowOnHost(otherHostId), rowOnHost(confirmedRowHostId)]
      }
    },
    // The user opened the LOCAL workspace, so removal routing prefers local.
    activeWorktreeId: WORKTREE_ID,
    activeWorkspaceExecutionHostId: LOCAL_HOST,
    activeView: 'terminal',
    activePendingCreationId: null,
    settings: { skipDeleteWorktreeConfirm: true },
    sshConnectionStates: new Map([['ssh-1', { targetId: 'ssh-1', status: 'connected' }]]),
    sshTargetLabels: new Map([['ssh-1', 'SSH One']]),
    worktreeLineageById: {}
  } as unknown as Partial<AppState>)
}

beforeEach(() => {
  vi.clearAllMocks()
  resetRemoteRuntimeMocks()
  resetWorktreeSliceModuleMemory()
  storeRef.current = createTestStore()
})

afterEach(cleanupHostCheckouts)

describe('STA-4343 sidebar delete: the confirmed row decides the host', () => {
  it('deletes the SSH row and leaves the ACTIVE local checkout on disk', async () => {
    const local = createHostCheckout(LOCAL_HOST)
    const ssh = createHostCheckout(SSH_HOST)
    const routedHostIds: string[] = []
    installRemovalTransports(
      { remove: mockApi.worktrees.remove, runtimeCall: runtimeEnvironmentCall },
      { [LOCAL_HOST]: local.root, [SSH_HOST]: ssh.root },
      routedHostIds
    )
    const store = storeRef.current as ReturnType<typeof createTestStore>
    seedCollidingSidebar(store, SSH_HOST)

    runWorktreeDelete(WORKTREE_ID, { expectedHostId: SSH_HOST })
    // Settle either outcome so the disk assertion reports misrouting rather than a missing spy call.
    await vi.waitFor(() => expect(routedHostIds.length + failureToastCount()).toBeGreaterThan(0))

    expect(
      fs.existsSync(local.markerPath),
      `the ACTIVE local checkout must survive deleting the SSH row; removal was routed to hostId=${routedHostIds.join(',') || '<none>'}`
    ).toBe(true)
    expect(fs.existsSync(ssh.markerPath), 'the confirmed SSH checkout must be gone').toBe(false)
    expect(routedHostIds).toEqual([SSH_HOST])
    expect(showDeleteWorktreeFailureToast).not.toHaveBeenCalled()
    expect(store.getState().worktreesByRepo.repo1).toHaveLength(1)
    expect(store.getState().worktreesByRepo.repo1?.[0]?.hostId).toBe(LOCAL_HOST)
  })

  it('routes the batch delete path to the confirmed host too', async () => {
    const local = createHostCheckout(LOCAL_HOST)
    const ssh = createHostCheckout(SSH_HOST)
    const routedHostIds: string[] = []
    installRemovalTransports(
      { remove: mockApi.worktrees.remove, runtimeCall: runtimeEnvironmentCall },
      { [LOCAL_HOST]: local.root, [SSH_HOST]: ssh.root },
      routedHostIds
    )
    const store = storeRef.current as ReturnType<typeof createTestStore>
    seedCollidingSidebar(store, SSH_HOST)

    const deletedTargets = await runWorktreeDeletesInParallel([rowOnHost(SSH_HOST)], {
      force: true
    })

    expect(
      fs.existsSync(local.markerPath),
      `the ACTIVE local checkout must survive a batch delete of the SSH row; removal was routed to hostId=${routedHostIds.join(',') || '<none>'}`
    ).toBe(true)
    expect(fs.existsSync(ssh.markerPath), 'the confirmed SSH checkout must be gone').toBe(false)
    expect(routedHostIds).toEqual([SSH_HOST])
    expect(deletedTargets).toEqual([{ id: WORKTREE_ID, executionHostId: SSH_HOST }])
  })

  it('tears down shared renderer state after both same-id host rows finish deleting', async () => {
    const local = createHostCheckout(LOCAL_HOST)
    const ssh = createHostCheckout(SSH_HOST)
    const routedHostIds: string[] = []
    installRemovalTransports(
      { remove: mockApi.worktrees.remove, runtimeCall: runtimeEnvironmentCall },
      { [LOCAL_HOST]: local.root, [SSH_HOST]: ssh.root },
      routedHostIds
    )
    const store = storeRef.current as ReturnType<typeof createTestStore>
    seedCollidingSidebar(store, SSH_HOST)
    store.setState({
      tabsByWorktree: {
        [WORKTREE_ID]: [makeTab({ id: 'shared-tab', worktreeId: WORKTREE_ID })]
      }
    } as unknown as Partial<AppState>)

    const deletedTargets = await runWorktreeDeletesInParallel([
      rowOnHost(LOCAL_HOST),
      rowOnHost(SSH_HOST)
    ])

    expect(fs.existsSync(local.markerPath)).toBe(false)
    expect(fs.existsSync(ssh.markerPath)).toBe(false)
    expect(new Set(routedHostIds)).toEqual(new Set([LOCAL_HOST, SSH_HOST]))
    expect(deletedTargets).toHaveLength(2)
    expect(store.getState().worktreesByRepo.repo1).toEqual([])
    expect(store.getState().tabsByWorktree[WORKTREE_ID]).toBeUndefined()
    expect(store.getState().activeWorktreeId).toBeNull()
  })

  it('still deletes the local checkout for real when the local row is the one deleted', async () => {
    const local = createHostCheckout(LOCAL_HOST)
    const ssh = createHostCheckout(SSH_HOST)
    const routedHostIds: string[] = []
    installRemovalTransports(
      { remove: mockApi.worktrees.remove, runtimeCall: runtimeEnvironmentCall },
      { [LOCAL_HOST]: local.root, [SSH_HOST]: ssh.root },
      routedHostIds
    )
    const store = storeRef.current as ReturnType<typeof createTestStore>
    seedCollidingSidebar(store, LOCAL_HOST)

    runWorktreeDelete(WORKTREE_ID, { expectedHostId: LOCAL_HOST })
    await vi.waitFor(() => expect(routedHostIds).toEqual([LOCAL_HOST]))

    expect(fs.existsSync(local.markerPath)).toBe(false)
    expect(fs.existsSync(ssh.markerPath)).toBe(true)
    expect(showDeleteWorktreeFailureToast).not.toHaveBeenCalled()
  })

  it('still deletes an ordinary single-host SSH workspace for real', async () => {
    const ssh = createHostCheckout(SSH_HOST)
    const routedHostIds: string[] = []
    installRemovalTransports(
      { remove: mockApi.worktrees.remove, runtimeCall: runtimeEnvironmentCall },
      { [SSH_HOST]: ssh.root },
      routedHostIds
    )
    const store = storeRef.current as ReturnType<typeof createTestStore>
    store.setState({
      repos: [
        {
          id: 'repo1',
          path: '/repo1',
          displayName: 'Repo 1',
          executionHostId: SSH_HOST,
          connectionId: 'ssh-1'
        }
      ],
      worktreesByRepo: { repo1: [rowOnHost(SSH_HOST)] },
      activeWorktreeId: null,
      activeView: 'terminal',
      activePendingCreationId: null,
      settings: { skipDeleteWorktreeConfirm: true },
      sshConnectionStates: new Map([['ssh-1', { targetId: 'ssh-1', status: 'connected' }]]),
      sshTargetLabels: new Map([['ssh-1', 'SSH One']]),
      worktreeLineageById: {}
    } as unknown as Partial<AppState>)

    runWorktreeDelete(WORKTREE_ID)
    await vi.waitFor(() => expect(routedHostIds).toEqual([SSH_HOST]))

    expect(fs.existsSync(ssh.markerPath)).toBe(false)
    expect(showDeleteWorktreeFailureToast).not.toHaveBeenCalled()
  })
})
