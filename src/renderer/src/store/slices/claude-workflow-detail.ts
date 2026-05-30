import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type {
  ClaudeWorkflowDetail,
  ClaudeWorkflowDetailTarget
} from '../../../../shared/claude-workflow-detail'

export type ClaudeWorkflowDetailStatus = {
  loading: boolean
  error: string | null
  detail: ClaudeWorkflowDetail | null
}

export type ClaudeWorkflowDetailSlice = {
  selectedClaudeWorkflowTarget: ClaudeWorkflowDetailTarget | null
  claudeWorkflowDetailEpoch: number
  claudeWorkflowDetailCache: Record<string, ClaudeWorkflowDetail>
  claudeWorkflowDetailStatus: ClaudeWorkflowDetailStatus
  openClaudeWorkflowDetail: (target: ClaudeWorkflowDetailTarget) => void
  closeClaudeWorkflowDetail: () => void
  loadClaudeWorkflowDetail: () => Promise<void>
}

export function getClaudeWorkflowDetailCacheKey(target: ClaudeWorkflowDetailTarget): string {
  return [
    target.paneKey,
    target.worktreeId,
    target.connectionId ?? 'local',
    target.selectors?.transcriptPath ?? '',
    target.selectors?.scriptPath ?? '',
    target.updatedAt,
    target.stateStartedAt
  ].join('\0')
}

export const createClaudeWorkflowDetailSlice: StateCreator<
  AppState,
  [],
  [],
  ClaudeWorkflowDetailSlice
> = (set, get) => ({
  selectedClaudeWorkflowTarget: null,
  claudeWorkflowDetailEpoch: 0,
  claudeWorkflowDetailCache: {},
  claudeWorkflowDetailStatus: {
    loading: false,
    error: null,
    detail: null
  },

  openClaudeWorkflowDetail: (target) => {
    const key = getClaudeWorkflowDetailCacheKey(target)
    const cached = get().claudeWorkflowDetailCache[key] ?? null
    set((state) => ({
      selectedClaudeWorkflowTarget: target,
      claudeWorkflowDetailEpoch: state.claudeWorkflowDetailEpoch + 1,
      claudeWorkflowDetailStatus: {
        loading: !cached,
        error: null,
        detail: cached
      }
    }))
    if (!cached) {
      void get().loadClaudeWorkflowDetail()
    }
  },

  closeClaudeWorkflowDetail: () => {
    set((state) => ({
      selectedClaudeWorkflowTarget: null,
      claudeWorkflowDetailEpoch: state.claudeWorkflowDetailEpoch + 1,
      claudeWorkflowDetailStatus: {
        loading: false,
        error: null,
        detail: null
      }
    }))
  },

  loadClaudeWorkflowDetail: async () => {
    const target = get().selectedClaudeWorkflowTarget
    if (!target) {
      return
    }
    const epoch = get().claudeWorkflowDetailEpoch
    const key = getClaudeWorkflowDetailCacheKey(target)
    const cached = get().claudeWorkflowDetailCache[key]
    if (cached) {
      set({ claudeWorkflowDetailStatus: { loading: false, error: null, detail: cached } })
      return
    }
    set((state) => ({
      claudeWorkflowDetailStatus: {
        ...state.claudeWorkflowDetailStatus,
        loading: true,
        error: null
      }
    }))
    try {
      const detail = await window.api.claudeWorkflows.getDetail({ target })
      const current = get().selectedClaudeWorkflowTarget
      if (
        !current ||
        epoch !== get().claudeWorkflowDetailEpoch ||
        getClaudeWorkflowDetailCacheKey(current) !== key
      ) {
        return
      }
      const nextKey = detail.mtimeMs !== undefined ? `${key}\0mtime:${detail.mtimeMs}` : key
      set((state) => ({
        claudeWorkflowDetailCache: {
          ...state.claudeWorkflowDetailCache,
          [key]: detail,
          [nextKey]: detail
        },
        claudeWorkflowDetailStatus: { loading: false, error: null, detail }
      }))
    } catch (error) {
      const current = get().selectedClaudeWorkflowTarget
      if (
        !current ||
        epoch !== get().claudeWorkflowDetailEpoch ||
        getClaudeWorkflowDetailCacheKey(current) !== key
      ) {
        return
      }
      set({
        claudeWorkflowDetailStatus: {
          loading: false,
          error: error instanceof Error ? error.message : 'Failed to load Claude workflow detail.',
          detail: null
        }
      })
    }
  }
})
