import type { StateCreator } from 'zustand'
import { createBrowserUuid } from '@/lib/browser-uuid'
import type { AppState } from '../types'
import {
  removeGroupLayoutLeaf,
  updateSplitRatio
} from '../../../../shared/workspace-layout/tab-group-layout-tree'
import {
  buildWorkspaceViewLayout,
  workspaceViewPanelKey,
  WORKSPACE_VIEW_MAX_PANELS,
  WORKSPACE_VIEW_MAX_SAVED,
  type WorkspaceView,
  type WorkspaceViewPanel,
  type WorkspaceViewPreset
} from '@/lib/workspace-view-layout'
import { loadWorkspaceViews, saveWorkspaceViews } from '@/lib/workspace-view-storage'

export type WorkspaceViewsSlice = {
  workspaceViews: readonly WorkspaceView[]
  activeWorkspaceViewId: string | null
  workspaceViewExpandedPanelId: string | null
  workspaceViewFillWindow: boolean
  workspaceViewPicker: { workspaceId?: string; replacePanelId?: string } | null
  createWorkspaceView: (name: string) => string | null
  selectWorkspaceView: (id: string | null) => void
  renameWorkspaceView: (id: string, name: string) => void
  removeWorkspaceView: (id: string) => void
  addWorkspaceViewPanel: (
    panel: Omit<WorkspaceViewPanel, 'id'>,
    replaceId?: string
  ) => string | null
  removeWorkspaceViewPanel: (panelId: string) => void
  setWorkspaceViewFocus: (panelId: string) => void
  setWorkspaceViewPreset: (preset: WorkspaceViewPreset) => void
  setWorkspaceViewRatio: (path: string[], ratio: number) => void
  moveWorkspaceViewPanel: (panelId: string, offset: -1 | 1) => void
  toggleWorkspaceViewPanelExpand: (panelId: string) => void
  toggleWorkspaceViewFillWindow: () => void
  setWorkspaceViewPicker: (picker: WorkspaceViewsSlice['workspaceViewPicker']) => void
}

export const createWorkspaceViewsSlice: StateCreator<AppState, [], [], WorkspaceViewsSlice> = (
  set,
  get
) => {
  const saved = loadWorkspaceViews()
  function commit(views: readonly WorkspaceView[], activeId = get().activeWorkspaceViewId): void {
    set({ workspaceViews: views, activeWorkspaceViewId: activeId })
    saveWorkspaceViews(views, activeId)
  }
  function update(change: (view: WorkspaceView) => WorkspaceView): void {
    const state = get()
    commit(
      state.workspaceViews.map((view) =>
        view.id === state.activeWorkspaceViewId ? change(view) : view
      )
    )
  }
  return {
    workspaceViews: saved.views,
    activeWorkspaceViewId: saved.activeId,
    workspaceViewExpandedPanelId: null,
    workspaceViewFillWindow: false,
    workspaceViewPicker: null,
    createWorkspaceView: (name) => {
      if (!name.trim() || get().workspaceViews.length >= WORKSPACE_VIEW_MAX_SAVED) {
        return null
      }
      const id = createBrowserUuid()
      commit(
        [
          ...get().workspaceViews,
          {
            id,
            name: name.trim().slice(0, 80),
            panels: [],
            layout: null,
            preset: 'grid',
            focusedPanelId: null
          }
        ],
        id
      )
      set({ workspaceViewExpandedPanelId: null })
      return id
    },
    selectWorkspaceView: (id) => {
      if (id !== null && !get().workspaceViews.some((view) => view.id === id)) {
        return
      }
      commit(get().workspaceViews, id)
      set({ workspaceViewExpandedPanelId: null, workspaceViewFillWindow: false })
    },
    renameWorkspaceView: (id, name) => {
      if (name.trim()) {
        commit(
          get().workspaceViews.map((view) =>
            view.id === id ? { ...view, name: name.trim().slice(0, 80) } : view
          )
        )
      }
    },
    removeWorkspaceView: (id) => {
      const state = get()
      commit(
        state.workspaceViews.filter((view) => view.id !== id),
        state.activeWorkspaceViewId === id ? null : state.activeWorkspaceViewId
      )
      set({ workspaceViewExpandedPanelId: null, workspaceViewFillWindow: false })
    },
    addWorkspaceViewPanel: (panel, replaceId) => {
      const view = get().workspaceViews.find((view) => view.id === get().activeWorkspaceViewId)
      if (!view) {
        return null
      }
      const duplicate = view.panels.find(
        (existing) => workspaceViewPanelKey(existing) === workspaceViewPanelKey(panel)
      )
      if (duplicate) {
        get().setWorkspaceViewFocus(duplicate.id)
        return duplicate.id
      }
      if (replaceId && !view.panels.some((p) => p.id === replaceId)) {
        return null
      }
      if (!replaceId && view.panels.length >= WORKSPACE_VIEW_MAX_PANELS) {
        return null
      }
      const id = replaceId ?? createBrowserUuid()
      update((current) => {
        const panels = replaceId
          ? current.panels.map((p) => (p.id === replaceId ? { ...panel, id } : p))
          : [...current.panels, { ...panel, id }]
        return {
          ...current,
          panels,
          focusedPanelId: id,
          layout: replaceId
            ? current.layout
            : buildWorkspaceViewLayout(
                panels.map((p) => p.id),
                current.preset
              )
        }
      })
      return id
    },
    removeWorkspaceViewPanel: (panelId) => {
      update((view) => ({
        ...view,
        panels: view.panels.filter((p) => p.id !== panelId),
        layout: view.layout ? removeGroupLayoutLeaf(view.layout, panelId) : null,
        focusedPanelId:
          view.focusedPanelId === panelId
            ? (view.panels.find((p) => p.id !== panelId)?.id ?? null)
            : view.focusedPanelId
      }))
      if (get().workspaceViewExpandedPanelId === panelId) {
        set({ workspaceViewExpandedPanelId: null })
      }
    },
    setWorkspaceViewFocus: (panelId) => {
      const view = get().workspaceViews.find((view) => view.id === get().activeWorkspaceViewId)
      if (view?.focusedPanelId !== panelId && view?.panels.some((p) => p.id === panelId)) {
        update((v) => ({ ...v, focusedPanelId: panelId }))
      }
    },
    setWorkspaceViewPreset: (preset) => {
      update((view) => ({
        ...view,
        preset,
        layout: buildWorkspaceViewLayout(
          view.panels.map((p) => p.id),
          preset
        )
      }))
      set({ workspaceViewExpandedPanelId: null })
    },
    setWorkspaceViewRatio: (path, ratio) => {
      if (
        !Number.isFinite(ratio) ||
        path.some((segment) => segment !== 'first' && segment !== 'second')
      ) {
        return
      }
      update((view) => ({
        ...view,
        layout: view.layout
          ? updateSplitRatio(view.layout, path, Math.max(0.15, Math.min(0.85, ratio)))
          : null
      }))
    },
    moveWorkspaceViewPanel: (panelId, offset) =>
      update((view) => {
        const index = view.panels.findIndex((panel) => panel.id === panelId),
          to = index + offset
        if (index === -1 || to < 0 || to >= view.panels.length) {
          return view
        }
        const panels = [...view.panels]
        ;[panels[index], panels[to]] = [panels[to], panels[index]]
        return {
          ...view,
          panels,
          layout: buildWorkspaceViewLayout(
            panels.map((panel) => panel.id),
            view.preset
          )
        }
      }),
    toggleWorkspaceViewPanelExpand: (panelId) =>
      set((state) => ({
        workspaceViewExpandedPanelId:
          state.workspaceViewExpandedPanelId === panelId ? null : panelId
      })),
    toggleWorkspaceViewFillWindow: () =>
      set((state) => ({ workspaceViewFillWindow: !state.workspaceViewFillWindow })),
    setWorkspaceViewPicker: (workspaceViewPicker) => set({ workspaceViewPicker })
  }
}
