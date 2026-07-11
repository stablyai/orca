import type { StateCreator } from 'zustand'
import type {
  Mission,
  MissionCreateResult,
  MissionDeleteResult,
  MissionMemberResult
} from '../../../../shared/types'

export type MissionsSlice = {
  missions: Mission[]
  /** Transient per-member worktree errors keyed `${missionId}:${repoId}`.
   *  Renderer-local: survives refetches but not reloads (failures are
   *  retryable states, not persisted data). */
  missionMemberErrors: Record<string, string>
  fetchMissions: () => Promise<void>
  createMission: (args: {
    name: string
    branchName?: string
    repoIds: string[]
  }) => Promise<MissionCreateResult | null>
  renameMission: (missionId: string, name: string) => Promise<void>
  deleteMission: (
    missionId: string,
    deleteWorktrees: boolean
  ) => Promise<MissionDeleteResult | null>
  addMissionMembers: (missionId: string, repoIds: string[]) => Promise<MissionCreateResult | null>
  removeMissionMember: (missionId: string, repoId: string, deleteWorktree: boolean) => Promise<void>
  recreateMissionMemberWorktree: (missionId: string, repoId: string) => Promise<void>
}

export const missionMemberErrorKey = (missionId: string, repoId: string): string =>
  `${missionId}:${repoId}`

export const createMissionsSlice: StateCreator<MissionsSlice, [], [], MissionsSlice> = (
  set,
  get
) => {
  function applyMemberResults(missionId: string, memberResults: MissionMemberResult[]): void {
    set((state) => {
      const next = { ...state.missionMemberErrors }
      for (const result of memberResults) {
        const key = missionMemberErrorKey(missionId, result.repoId)
        if (result.error) {
          next[key] = result.error
        } else {
          delete next[key]
        }
      }
      return { missionMemberErrors: next }
    })
  }

  return {
    missions: [],
    missionMemberErrors: {},

    fetchMissions: async () => {
      try {
        const missions = await window.api.missions.list()
        set({ missions })
      } catch (err) {
        console.error('Failed to fetch missions:', err)
      }
    },

    createMission: async (args) => {
      try {
        const result = await window.api.missions.create(args)
        applyMemberResults(result.mission.id, result.memberResults)
        await get().fetchMissions()
        return result
      } catch (err) {
        console.error('Failed to create mission:', err)
        return null
      }
    },

    renameMission: async (missionId, name) => {
      try {
        await window.api.missions.update({ missionId, updates: { name } })
        await get().fetchMissions()
      } catch (err) {
        console.error('Failed to rename mission:', err)
      }
    },

    deleteMission: async (missionId, deleteWorktrees) => {
      try {
        const result = await window.api.missions.delete({ missionId, deleteWorktrees })
        applyMemberResults(missionId, result.memberResults)
        await get().fetchMissions()
        return result
      } catch (err) {
        console.error('Failed to delete mission:', err)
        return null
      }
    },

    addMissionMembers: async (missionId, repoIds) => {
      try {
        const result = await window.api.missions.addMembers({ missionId, repoIds })
        applyMemberResults(missionId, result.memberResults)
        await get().fetchMissions()
        return result
      } catch (err) {
        console.error('Failed to add mission members:', err)
        return null
      }
    },

    removeMissionMember: async (missionId, repoId, deleteWorktree) => {
      try {
        const result = await window.api.missions.removeMember({ missionId, repoId, deleteWorktree })
        applyMemberResults(missionId, result.memberResults)
        await get().fetchMissions()
      } catch (err) {
        console.error('Failed to remove mission member:', err)
      }
    },

    recreateMissionMemberWorktree: async (missionId, repoId) => {
      try {
        const result = await window.api.missions.recreateMemberWorktree({ missionId, repoId })
        applyMemberResults(missionId, [result])
        await get().fetchMissions()
      } catch (err) {
        console.error('Failed to recreate mission worktree:', err)
      }
    }
  }
}
