import { beforeEach, describe, expect, it, vi } from 'vitest'
import { create, type StateCreator } from 'zustand'
import { createMissionsSlice, missionMemberErrorKey, type MissionsSlice } from './missions'
import type { Mission, MissionCreateResult } from '../../../../shared/types'

const missionsApi = {
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  addMembers: vi.fn(),
  removeMember: vi.fn(),
  recreateMemberWorktree: vi.fn(),
  ensureSession: vi.fn()
}

vi.stubGlobal('window', {
  api: { missions: missionsApi }
})

type TestState = MissionsSlice & { fetchFolderWorkspaces: ReturnType<typeof vi.fn> }

function makeStore() {
  const createSlice = createMissionsSlice as unknown as StateCreator<
    TestState,
    [],
    [],
    MissionsSlice
  >
  return create<TestState>()((...a) => ({
    ...createSlice(...a),
    fetchFolderWorkspaces: vi.fn(async () => {})
  }))
}

const mission: Mission = {
  id: 'm1',
  name: 'Referral',
  branchName: 'mission/referral',
  members: [
    { repoId: 'r1', worktreeId: 'r1::/wt', addedAt: 1 },
    { repoId: 'r2', worktreeId: null, addedAt: 1 }
  ],
  tabOrder: 0,
  createdAt: 1,
  updatedAt: 1
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('missions slice', () => {
  it('fetchMissions stores the fetched list', async () => {
    missionsApi.list.mockResolvedValue([mission])
    const store = makeStore()
    await store.getState().fetchMissions()
    expect(store.getState().missions).toEqual([mission])
  })

  it('createMission records per-member errors and refreshes the list', async () => {
    const result: MissionCreateResult = {
      mission,
      memberResults: [
        { repoId: 'r1', worktreeId: 'r1::/wt' },
        { repoId: 'r2', worktreeId: null, error: 'Branch already exists' }
      ]
    }
    missionsApi.create.mockResolvedValue(result)
    missionsApi.list.mockResolvedValue([mission])
    const store = makeStore()
    const created = await store
      .getState()
      .createMission({ name: 'Referral', repoIds: ['r1', 'r2'] })
    expect(created).toEqual(result)
    expect(store.getState().missionMemberErrors[missionMemberErrorKey('m1', 'r2')]).toBe(
      'Branch already exists'
    )
    expect(store.getState().missions).toEqual([mission])
  })

  it('ensureMissionSession refreshes folder workspaces before returning', async () => {
    const workspace = { id: 'fw-1', missionId: 'm1' }
    missionsApi.ensureSession.mockResolvedValue(workspace)
    missionsApi.list.mockResolvedValue([mission])
    const store = makeStore()
    const result = await store.getState().ensureMissionSession('m1')
    expect(result).toEqual(workspace)
    expect(store.getState().fetchFolderWorkspaces).toHaveBeenCalled()
    expect(missionsApi.ensureSession).toHaveBeenCalledWith({ missionId: 'm1' })
  })

  it('recreate clears the member error on success', async () => {
    missionsApi.recreateMemberWorktree.mockResolvedValue({ repoId: 'r2', worktreeId: 'r2::/wt' })
    missionsApi.list.mockResolvedValue([mission])
    const store = makeStore()
    store.setState({ missionMemberErrors: { [missionMemberErrorKey('m1', 'r2')]: 'old' } })
    await store.getState().recreateMissionMemberWorktree('m1', 'r2')
    expect(store.getState().missionMemberErrors[missionMemberErrorKey('m1', 'r2')]).toBeUndefined()
  })
})
