import { useEffect } from 'react'
import { useAppStore } from '../store'

const ZOOM_STEP = 0.5

export function useIpcEvents(): void {
  useEffect(() => {
    const unsubs: (() => void)[] = []

    unsubs.push(
      window.api.repos.onChanged(() => {
        useAppStore.getState().fetchRepos()
      })
    )

    unsubs.push(
      window.api.worktrees.onChanged((data: { repoId: string }) => {
        useAppStore.getState().fetchWorktrees(data.repoId)
      })
    )

    unsubs.push(
      window.api.ui.onOpenSettings(() => {
        useAppStore.getState().setActiveView('settings')
      })
    )

    // Browser zoom fallback when no terminal is active
    unsubs.push(
      window.api.ui.onTerminalZoom((direction) => {
        const { activeView } = useAppStore.getState()
        if (activeView === 'terminal') return
        const current = window.api.ui.getZoomLevel()
        if (direction === 'in') window.api.ui.setZoomLevel(current + ZOOM_STEP)
        else if (direction === 'out') window.api.ui.setZoomLevel(current - ZOOM_STEP)
        else window.api.ui.setZoomLevel(0)
      })
    )

    return () => unsubs.forEach((fn) => fn())
  }, [])
}
