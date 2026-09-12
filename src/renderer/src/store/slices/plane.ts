import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type {
  PlaneConnectArgs,
  PlaneConnectionStatus,
  PlaneIssue,
  PlaneIssueFilter,
  PlaneIssueUpdate,
  PlaneMutationResult,
  PlaneProject,
  PlaneState,
  PlaneViewer
} from '../../../../shared/plane-types'

export type PlaneSlice = {
  planeStatus: PlaneConnectionStatus
  planeStatusChecked: boolean
  planeProjects: PlaneProject[]
  planeStates: Record<string, PlaneState[]>
  planeIssues: PlaneIssue[]
  planeLoading: boolean
  planeError: string | null

  checkPlaneConnection: () => Promise<void>
  connectPlane: (
    args: PlaneConnectArgs
  ) => Promise<{ ok: true; viewer: PlaneViewer } | { ok: false; error: string }>
  disconnectPlane: () => Promise<void>
  selectPlaneWorkspace: (workspaceSlug: string) => Promise<void>
  fetchPlaneProjects: (workspaceSlug?: string) => Promise<PlaneProject[]>
  fetchPlaneStates: (workspaceSlug: string, projectId: string) => Promise<PlaneState[]>
  fetchPlaneIssues: (args?: {
    workspaceSlug?: string
    projectId?: string
    filter?: PlaneIssueFilter
    limit?: number
  }) => Promise<PlaneIssue[]>
  updatePlaneIssue: (args: {
    workspaceSlug: string
    projectId: string
    issueId: string
    update: PlaneIssueUpdate
  }) => Promise<PlaneMutationResult>
}

export const createPlaneSlice: StateCreator<AppState, [], [], PlaneSlice> = (set, get) => ({
  planeStatus: {
    connected: false,
    viewer: null,
    instanceUrl: 'https://api.plane.so',
    authType: 'cloud',
    workspaces: [],
    activeWorkspaceSlug: null,
    selectedWorkspaceSlug: null
  },
  planeStatusChecked: false,
  planeProjects: [],
  planeStates: {},
  planeIssues: [],
  planeLoading: false,
  planeError: null,

  checkPlaneConnection: async (): Promise<void> => {
    try {
      const status = await window.api.plane.status()
      set({ planeStatus: status, planeStatusChecked: true })
    } catch {
      set({ planeStatusChecked: true })
    }
  },

  connectPlane: async (
    args: PlaneConnectArgs
  ): Promise<{ ok: true; viewer: PlaneViewer } | { ok: false; error: string }> => {
    try {
      const result = await window.api.plane.connect(args)
      if (result.ok) {
        const status = await window.api.plane.status()
        set({ planeStatus: status })
        void get().fetchPlaneProjects()
      }
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Connection failed'
      return { ok: false, error: message }
    }
  },

  disconnectPlane: async (): Promise<void> => {
    try {
      const status = await window.api.plane.disconnect()
      set({
        planeStatus: status,
        planeProjects: [],
        planeStates: {},
        planeIssues: []
      })
    } catch (error) {
      console.error('[plane] disconnect failed:', error)
    }
  },

  selectPlaneWorkspace: async (workspaceSlug: string): Promise<void> => {
    try {
      const status = await window.api.plane.selectWorkspace({ workspaceSlug })
      set({ planeStatus: status, planeIssues: [] })
      await get().fetchPlaneProjects(workspaceSlug)
    } catch (error) {
      console.error('[plane] selectWorkspace failed:', error)
    }
  },

  fetchPlaneProjects: async (workspaceSlug?: string): Promise<PlaneProject[]> => {
    try {
      const projects = await window.api.plane.listProjects({ workspaceSlug })
      set({ planeProjects: projects })
      return projects
    } catch (error) {
      console.error('[plane] fetchProjects failed:', error)
      return []
    }
  },

  fetchPlaneStates: async (
    workspaceSlug: string,
    projectId: string
  ): Promise<PlaneState[]> => {
    try {
      const states = await window.api.plane.listStates({ workspaceSlug, projectId })
      set((state) => ({
        planeStates: {
          ...state.planeStates,
          [projectId]: states
        }
      }))
      return states
    } catch (error) {
      console.error('[plane] fetchStates failed:', error)
      return []
    }
  },

  fetchPlaneIssues: async (args?: {
    workspaceSlug?: string
    projectId?: string
    filter?: PlaneIssueFilter
    limit?: number
  }): Promise<PlaneIssue[]> => {
    set({ planeLoading: true, planeError: null })
    try {
      const issues = await window.api.plane.listIssues(args)
      set({ planeIssues: issues, planeLoading: false })
      return issues
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to fetch issues'
      set({ planeLoading: false, planeError: message })
      return []
    }
  },

  updatePlaneIssue: async (args: {
    workspaceSlug: string
    projectId: string
    issueId: string
    update: PlaneIssueUpdate
  }): Promise<PlaneMutationResult> => {
    try {
      const result = await window.api.plane.updateIssue(args)
      if (result.ok) {
        // Optimistically or refetch updated issue in list
        set((state) => ({
          planeIssues: state.planeIssues.map((issue) => {
            if (issue.id !== args.issueId) {
              return issue
            }
            const updated = { ...issue }
            if (args.update.title) {
              updated.title = args.update.title
            }
            if (args.update.priority) {
              updated.priority = args.update.priority
            }
            return updated
          })
        }))
      }
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to update issue'
      return { ok: false, error: message }
    }
  }
})
