import { useEffect } from 'react'
import { useAppStore } from '../store'
import { applyUIZoom } from '@/lib/ui-zoom'
import { ensureWorktreeHasInitialTerminal } from '@/lib/worktree-activation'
import type { UpdateStatus } from '../../../shared/types'
import { createUpdateToastController } from './update-toast-controller'

const ZOOM_STEP = 0.5

export function useIpcEvents(): void {
  useEffect(() => {
    const unsubs: (() => void)[] = []
    const updateToastController = createUpdateToastController()

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

    unsubs.push(
      window.api.ui.onActivateWorktree(({ repoId, worktreeId, setup }) => {
        void (async () => {
          const store = useAppStore.getState()
          await store.fetchWorktrees(repoId)
          // Why: CLI-created worktrees should feel identical to UI-created
          // worktrees. The renderer owns the "active worktree -> first tab"
          // behavior today, so we explicitly replay that activation sequence
          // after the runtime creates a worktree outside the renderer.
          store.setActiveRepo(repoId)
          store.setActiveView('terminal')
          store.setActiveWorktree(worktreeId)
          ensureWorktreeHasInitialTerminal(store, worktreeId, setup)

          store.revealWorktreeInSidebar(worktreeId)
        })().catch((error) => {
          console.error('Failed to activate CLI-created worktree:', error)
        })
      })
    )

    // Hydrate initial update status then subscribe to changes
    window.api.updater.getStatus().then((status) => {
      useAppStore.getState().setUpdateStatus(status as UpdateStatus)
    })

    unsubs.push(
      window.api.updater.onStatus((raw) => {
        const status = raw as UpdateStatus
        useAppStore.getState().setUpdateStatus(status)
        updateToastController.handleStatus(status)
      })
    )

    unsubs.push(
      window.api.ui.onFullscreenChanged((isFullScreen) => {
        useAppStore.getState().setIsFullScreen(isFullScreen)
      })
    )

    // Browser zoom fallback when no terminal is active
    unsubs.push(
      window.api.ui.onTerminalZoom((direction) => {
        const { activeView } = useAppStore.getState()
        if (activeView === 'terminal') {
          return
        }
        const current = window.api.ui.getZoomLevel()
        let next: number
        if (direction === 'in') {
          next = current + ZOOM_STEP
        } else if (direction === 'out') {
          next = current - ZOOM_STEP
        } else {
          next = 0
        }
        applyUIZoom(next)
        window.api.ui.set({ uiZoomLevel: next })
      })
    )

    return () => unsubs.forEach((fn) => fn())
  }, [])
}
