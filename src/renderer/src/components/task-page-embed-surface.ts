import { useCallback, useState } from 'react'
import { useAppStore } from '@/store'
import type { UISlice } from '@/store/slices/ui'
import type { TaskResumeState } from '../../../shared/types'

export type TaskPageData = UISlice['taskPageData']

/** Present when TaskPage renders inside a per-worktree tasks tab instead of
 *  the global `activeView === 'tasks'` view. */
export type TaskPageEmbedContext = {
  worktreeId: string
  lockedRepoId: string
  /** Why: overlay panes stay mounted while hidden; window-level shortcut
   *  listeners (e.g. Cmd+F) must only attach for the visible instance. */
  isActive?: boolean
}

export type TaskPageSurface = {
  isEmbedded: boolean
  pageData: TaskPageData
  openTaskPage: UISlice['openTaskPage']
  closeTaskPage: () => void
  patchPageData: (patch: Partial<TaskPageData>) => void
  taskResumeState: TaskResumeState | undefined
  setTaskResumeState: (updates: Partial<TaskResumeState>) => void
}

const EMPTY_PAGE_DATA: TaskPageData = {}

/**
 * Why: taskPageData/openTaskPage are window singletons (openTaskPage flips
 * activeView and writes nav history). Embedded tab instances keep all page
 * state per-instance, or a hidden background tab would hijack the window.
 */
export function useTaskPageSurface(embed?: TaskPageEmbedContext): TaskPageSurface {
  const isEmbedded = embed !== undefined
  // Selectors return constants when embedded so global-page updates don't
  // re-render tab instances; hook order stays identical in both modes.
  const storeResumeState = useAppStore((s) => (isEmbedded ? undefined : s.taskResumeState))
  const storeSetTaskResumeState = useAppStore((s) => s.setTaskResumeState)
  const storePageData = useAppStore((s) => (isEmbedded ? EMPTY_PAGE_DATA : s.taskPageData))
  const storeOpenTaskPage = useAppStore((s) => s.openTaskPage)
  const storeCloseTaskPage = useAppStore((s) => s.closeTaskPage)

  const [localPageData, setLocalPageData] = useState<TaskPageData>(() =>
    embed ? { preselectedRepoId: embed.lockedRepoId } : EMPTY_PAGE_DATA
  )
  const [localResumeState, setLocalResumeState] = useState<TaskResumeState | undefined>(undefined)

  // Mirrors the store's replace semantics (ui.ts sets `taskPageData: data`)
  // without the activeView/nav-history side effects.
  const localOpenTaskPage = useCallback<UISlice['openTaskPage']>((data = {}) => {
    setLocalPageData(data)
  }, [])

  const localCloseTaskPage = useCallback(() => {
    setLocalPageData(EMPTY_PAGE_DATA)
  }, [])

  const localPatchPageData = useCallback((patch: Partial<TaskPageData>) => {
    setLocalPageData((prev) => ({ ...prev, ...patch }))
  }, [])

  const storePatchPageData = useCallback((patch: Partial<TaskPageData>) => {
    useAppStore.setState((s) => ({ taskPageData: { ...s.taskPageData, ...patch } }))
  }, [])

  // Embedded resume state is per-tab and session-local: persisting through
  // window.api.ui.set would overwrite the global page's saved resume state.
  const localSetTaskResumeState = useCallback((updates: Partial<TaskResumeState>) => {
    setLocalResumeState((prev) => ({ ...prev, ...updates }))
  }, [])

  if (embed) {
    return {
      isEmbedded: true,
      pageData: localPageData,
      openTaskPage: localOpenTaskPage,
      closeTaskPage: localCloseTaskPage,
      patchPageData: localPatchPageData,
      taskResumeState: localResumeState,
      setTaskResumeState: localSetTaskResumeState
    }
  }
  return {
    isEmbedded: false,
    pageData: storePageData,
    openTaskPage: storeOpenTaskPage,
    closeTaskPage: storeCloseTaskPage,
    patchPageData: storePatchPageData,
    taskResumeState: storeResumeState,
    setTaskResumeState: storeSetTaskResumeState
  }
}
