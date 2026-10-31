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

import { toast } from 'sonner'
import { showDeleteWorktreeFailureToast } from './delete-worktree-failure-toast'
import { runWorktreeDelete, runWorktreeDeletesInParallel } from './delete-worktree-flow'

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
  it('offers to forget the confirmed SSH row and leaves the ACTIVE local checkout on disk', () => {
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

    // This app serves no ssh: host (#34677); only the SSH row's own records may be forgotten.
    expect(store.getState().openModal).toHaveBeenCalledWith(
      'forget-ssh-workspace',
      expect.objectContaining({ resolution: { kind: 'saved', targetId: 'ssh-1' } })
    )
    expect(routedHostIds).toEqual([])
    expect(fs.existsSync(local.markerPath)).toBe(true)
    expect(store.getState().worktreesByRepo.repo1).toHaveLength(2)
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

  it('deletes neither checkout when two hosts share the id and no host is named', async () => {
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

    runWorktreeDelete(WORKTREE_ID)
    await vi.waitFor(() => expect(toast.info).toHaveBeenCalled())

    expect(fs.existsSync(local.markerPath), 'the local checkout must survive').toBe(true)
    expect(fs.existsSync(ssh.markerPath), 'the SSH checkout must survive').toBe(true)
    expect(routedHostIds).toEqual([])
    expect(store.getState().worktreesByRepo.repo1).toHaveLength(2)
  })

  // #34677: nothing would serve the delete, so offer only Remove from Orca.
  it('never sends a destructive delete for an SSH workspace no server serves', async () => {
    const ssh = createHostCheckout(SSH_HOST)
    const routedHostIds: string[] = []
    installRemovalTransports(
      { remove: mockApi.worktrees.remove, runtimeCall: runtimeEnvironmentCall },
      { [SSH_HOST]: ssh.root },
      routedHostIds
    )
    const store = createTestStore()
    storeRef.current = store
    store.setState({
      repos: [
        {
          id: 'repo1',
          path: '/repo1',
          displayName: 'Repo 1',
          badgeColor: '#000000',
          addedAt: 0,
          executionHostId: SSH_HOST,
          connectionId: 'ssh-1'
        }
      ],
      worktreesByRepo: { repo1: [rowOnHost(SSH_HOST)] },
      sshTargetLabels: new Map([['ssh-1', 'SSH One']]),
      worktreeLineageById: {}
    })

    runWorktreeDelete(WORKTREE_ID)

    expect(store.getState().openModal).toHaveBeenCalledWith(
      'forget-ssh-workspace',
      expect.objectContaining({ resolution: { kind: 'saved', targetId: 'ssh-1' } })
    )
    expect(routedHostIds).toEqual([])
    expect(fs.existsSync(ssh.markerPath)).toBe(true)
  })
})
