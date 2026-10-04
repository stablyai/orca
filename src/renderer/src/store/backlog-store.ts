import { create } from 'zustand'
import type {
  AssignedAgentInfo,
  BacklogCategoryFilter,
  BacklogItem,
  BacklogItemKind,
  BacklogStatusFilter,
  BacklogViewMode
} from '../../../shared/backlog-types'

type BacklogStoreState = {
  isBacklogOpen: boolean
  viewMode: BacklogViewMode
  categoryFilter: BacklogCategoryFilter
  statusFilter: BacklogStatusFilter
  searchQuery: string
  items: BacklogItem[]
  customItems: BacklogItem[]
  setBacklogOpen: (open: boolean) => void
  setViewMode: (mode: BacklogViewMode) => void
  setCategoryFilter: (filter: BacklogCategoryFilter) => void
  setStatusFilter: (filter: BacklogStatusFilter) => void
  setSearchQuery: (query: string) => void
  setItems: (items: BacklogItem[]) => void
  toggleItemStatus: (id: string) => void
  assignAgentToItem: (id: string, agent: AssignedAgentInfo | undefined) => void
  addCustomItem: (title: string, kind?: BacklogItemKind) => void
  removeCustomItem: (id: string) => void
}

export const useBacklogStore = create<BacklogStoreState>((set) => ({
  isBacklogOpen: false,
  viewMode: 'checklist',
  categoryFilter: 'all',
  statusFilter: 'all',
  searchQuery: '',
  items: [],
  customItems: [],

  setBacklogOpen: (open: boolean) => set({ isBacklogOpen: open }),
  setViewMode: (viewMode: BacklogViewMode) => set({ viewMode }),
  setCategoryFilter: (categoryFilter: BacklogCategoryFilter) => set({ categoryFilter }),
  setStatusFilter: (statusFilter: BacklogStatusFilter) => set({ statusFilter }),
  setSearchQuery: (searchQuery: string) => set({ searchQuery }),
  setItems: (items: BacklogItem[]) => set({ items }),

  toggleItemStatus: (id: string) =>
    set((state) => {
      const updateItem = (item: BacklogItem): BacklogItem => {
        if (item.id !== id) {
          return item
        }
        const nextStatus = item.status === 'completed' ? 'todo' : 'completed'
        return { ...item, status: nextStatus }
      }

      return {
        items: state.items.map(updateItem),
        customItems: state.customItems.map(updateItem)
      }
    }),

  assignAgentToItem: (id: string, agent: AssignedAgentInfo | undefined) =>
    set((state) => {
      const updateItem = (item: BacklogItem): BacklogItem => {
        if (item.id !== id) {
          return item
        }
        const nextStatus = agent
          ? 'in_progress'
          : item.status === 'in_progress'
            ? 'todo'
            : item.status
        return { ...item, assignedAgent: agent, status: nextStatus }
      }

      return {
        items: state.items.map(updateItem),
        customItems: state.customItems.map(updateItem)
      }
    }),

  addCustomItem: (title: string, kind: BacklogItemKind = 'task') =>
    set((state) => {
      const newItem: BacklogItem = {
        id: `custom-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        kind,
        title: title.trim(),
        status: 'todo',
        updatedAt: Date.now()
      }
      return {
        customItems: [newItem, ...state.customItems]
      }
    }),

  removeCustomItem: (id: string) =>
    set((state) => ({
      customItems: state.customItems.filter((i) => i.id !== id)
    }))
}))
