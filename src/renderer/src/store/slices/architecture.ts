import type { StateCreator } from 'zustand'
import type { ArchitectureWorkspace, WorkspaceSessionState } from '../../../../shared/types'
import type { AppState } from '../types'

type CreateArchitectureTabOptions = {
  targetGroupId?: string
  title?: string
  label?: string
  modelRef?: string | null
  projectPath?: string | null
}

export type ArchitectureSlice = {
  architectureTabsByWorktree: Record<string, ArchitectureWorkspace[]>
  activeArchitectureTabId: string | null
  activeArchitectureTabIdByWorktree: Record<string, string | null>
  createArchitectureTab: (
    worktreeId: string,
    options?: CreateArchitectureTabOptions
  ) => ArchitectureWorkspace
  closeArchitectureTab: (tabId: string) => void
  setActiveArchitectureTab: (tabId: string) => void
  setArchitectureModelRef: (tabId: string, modelRef: string | null) => void
  hydrateArchitectureSession: (session: WorkspaceSessionState) => void
}

function getValidWorktreeIds(state: AppState): Set<string> {
  return new Set(
    Object.values(state.worktreesByRepo).flatMap((worktrees) => worktrees.map((w) => w.id))
  )
}

export const createArchitectureSlice: StateCreator<AppState, [], [], ArchitectureSlice> = (
  set,
  get
) => ({
  architectureTabsByWorktree: {},
  activeArchitectureTabId: null,
  activeArchitectureTabIdByWorktree: {},

  createArchitectureTab: (worktreeId, options) => {
    const id = globalThis.crypto.randomUUID()
    const title = options?.title ?? 'Architecture'
    const workspace: ArchitectureWorkspace = {
      id,
      worktreeId,
      label: options?.label,
      modelRef: options?.modelRef ?? null,
      projectPath: options?.projectPath ?? null,
      title,
      createdAt: Date.now()
    }

    const unifiedTab = get().createUnifiedTab(worktreeId, 'architecture', {
      entityId: id,
      label: workspace.label ?? title,
      targetGroupId: options?.targetGroupId
    })

    set((state) => ({
      architectureTabsByWorktree: {
        ...state.architectureTabsByWorktree,
        [worktreeId]: [...(state.architectureTabsByWorktree[worktreeId] ?? []), workspace]
      },
      activeArchitectureTabId: id,
      activeArchitectureTabIdByWorktree: {
        ...state.activeArchitectureTabIdByWorktree,
        [worktreeId]: id
      },
      activeTabType: 'architecture',
      activeTabTypeByWorktree: {
        ...state.activeTabTypeByWorktree,
        [worktreeId]: 'architecture'
      },
      activeGroupIdByWorktree: {
        ...state.activeGroupIdByWorktree,
        [worktreeId]: unifiedTab.groupId
      }
    }))

    return workspace
  },

  closeArchitectureTab: (tabId) => {
    const state = get()
    let ownerWorktreeId: string | null = null
    for (const [worktreeId, tabs] of Object.entries(state.architectureTabsByWorktree)) {
      if (tabs.some((tab) => tab.id === tabId)) {
        ownerWorktreeId = worktreeId
        break
      }
    }
    if (!ownerWorktreeId) {
      return
    }

    const unifiedId =
      (state.unifiedTabsByWorktree[ownerWorktreeId] ?? []).find(
        (tab) => tab.contentType === 'architecture' && tab.entityId === tabId
      )?.id ?? null

    set((current) => {
      const nextTabs = (current.architectureTabsByWorktree[ownerWorktreeId!] ?? []).filter(
        (tab) => tab.id !== tabId
      )
      const nextActive =
        current.activeArchitectureTabIdByWorktree[ownerWorktreeId!] === tabId
          ? (nextTabs[0]?.id ?? null)
          : (current.activeArchitectureTabIdByWorktree[ownerWorktreeId!] ?? null)
      return {
        architectureTabsByWorktree: {
          ...current.architectureTabsByWorktree,
          [ownerWorktreeId!]: nextTabs
        },
        activeArchitectureTabId:
          current.activeArchitectureTabId === tabId ? nextActive : current.activeArchitectureTabId,
        activeArchitectureTabIdByWorktree: {
          ...current.activeArchitectureTabIdByWorktree,
          [ownerWorktreeId!]: nextActive
        }
      }
    })

    if (unifiedId) {
      get().closeUnifiedTab(unifiedId)
    }
  },

  setActiveArchitectureTab: (tabId) => {
    const state = get()
    let ownerWorktreeId: string | null = null
    for (const [worktreeId, tabs] of Object.entries(state.architectureTabsByWorktree)) {
      if (tabs.some((tab) => tab.id === tabId)) {
        ownerWorktreeId = worktreeId
        break
      }
    }
    if (!ownerWorktreeId) {
      return
    }

    const unified = (state.unifiedTabsByWorktree[ownerWorktreeId] ?? []).find(
      (tab) => tab.contentType === 'architecture' && tab.entityId === tabId
    )
    if (unified) {
      state.focusGroup(ownerWorktreeId, unified.groupId)
      state.activateTab(unified.id)
    }

    set((current) => ({
      activeArchitectureTabId: tabId,
      activeArchitectureTabIdByWorktree: {
        ...current.activeArchitectureTabIdByWorktree,
        [ownerWorktreeId!]: tabId
      },
      activeTabType: 'architecture',
      activeTabTypeByWorktree: {
        ...current.activeTabTypeByWorktree,
        [ownerWorktreeId!]: 'architecture'
      }
    }))
  },

  setArchitectureModelRef: (tabId, modelRef) => {
    set((current) => {
      let changed = false
      const architectureTabsByWorktree = Object.fromEntries(
        Object.entries(current.architectureTabsByWorktree).map(([worktreeId, tabs]) => [
          worktreeId,
          tabs.map((tab) => {
            if (tab.id !== tabId) {
              return tab
            }
            changed = true
            return { ...tab, modelRef }
          })
        ])
      )
      return changed ? { architectureTabsByWorktree } : {}
    })
  },

  hydrateArchitectureSession: (session) => {
    const validWorktreeIds = getValidWorktreeIds(get())
    const architectureTabsByWorktree: Record<string, ArchitectureWorkspace[]> = {}
    for (const [worktreeId, tabs] of Object.entries(session.architectureTabsByWorktree ?? {})) {
      if (!validWorktreeIds.has(worktreeId)) {
        continue
      }
      architectureTabsByWorktree[worktreeId] = tabs.filter((tab) => tab.worktreeId === worktreeId)
    }

    const activeArchitectureTabIdByWorktree: Record<string, string | null> = {}
    for (const [worktreeId, tabs] of Object.entries(architectureTabsByWorktree)) {
      const persisted = session.activeArchitectureTabIdByWorktree?.[worktreeId] ?? null
      activeArchitectureTabIdByWorktree[worktreeId] = tabs.some((tab) => tab.id === persisted)
        ? persisted
        : (tabs[0]?.id ?? null)
    }

    const current = get()
    const activeWorktreeId = current.activeWorktreeId
    const activeTabTypeByWorktree = { ...current.activeTabTypeByWorktree }
    for (const [worktreeId, tabType] of Object.entries(activeTabTypeByWorktree)) {
      if (tabType === 'architecture' && !activeArchitectureTabIdByWorktree[worktreeId]) {
        delete activeTabTypeByWorktree[worktreeId]
      }
    }
    for (const [worktreeId, tabId] of Object.entries(activeArchitectureTabIdByWorktree)) {
      if (tabId && session.activeTabTypeByWorktree?.[worktreeId] === 'architecture') {
        activeTabTypeByWorktree[worktreeId] = 'architecture'
      }
    }
    const activeArchitectureTabId = activeWorktreeId
      ? (activeArchitectureTabIdByWorktree[activeWorktreeId] ?? null)
      : null
    const shouldActivateArchitecture =
      Boolean(activeArchitectureTabId) &&
      activeWorktreeId !== null &&
      activeTabTypeByWorktree[activeWorktreeId] === 'architecture'

    set({
      architectureTabsByWorktree,
      activeArchitectureTabId,
      activeArchitectureTabIdByWorktree,
      activeTabTypeByWorktree,
      ...(shouldActivateArchitecture ? { activeTabType: 'architecture' as const } : {})
    })
  }
})
