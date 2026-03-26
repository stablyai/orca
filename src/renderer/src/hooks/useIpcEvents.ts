import { useEffect } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '../store'
import { applyUIZoom } from '@/lib/ui-zoom'
import type { UpdateStatus } from '../../../shared/types'

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

    // Hydrate initial update status then subscribe to changes
    window.api.updater.getStatus().then((status) => {
      useAppStore.getState().setUpdateStatus(status as UpdateStatus)
    })

    let checkingToastId: string | number | undefined
    let availableToastId: string | number | undefined
    unsubs.push(
      window.api.updater.onStatus((raw) => {
        const status = raw as UpdateStatus
        useAppStore.getState().setUpdateStatus(status)

        // Show toasts for user-initiated checks
        if (status.state === 'checking' && 'userInitiated' in status && status.userInitiated) {
          checkingToastId = toast.loading('Checking for updates...')
        } else if (status.state === 'not-available') {
          if ('userInitiated' in status && status.userInitiated) {
            toast.success('You\u2019re on the latest version.', { id: checkingToastId })
            checkingToastId = undefined
          }
        } else if (status.state === 'available') {
          if (checkingToastId) {
            toast.dismiss(checkingToastId)
          }
          checkingToastId = undefined
          availableToastId = toast.info(`Version ${status.version} is available.`, {
            duration: Infinity,
            action: {
              label: 'Install',
              onClick: () => window.api.updater.download()
            }
          })
        } else if (status.state === 'downloading') {
          if (availableToastId) {
            toast.dismiss(availableToastId)
            availableToastId = undefined
          }
        } else if (status.state === 'downloaded') {
          if (availableToastId) {
            toast.dismiss(availableToastId)
            availableToastId = undefined
          }
          toast.success(`Version ${status.version} is ready to install.`, {
            duration: Infinity,
            action: {
              label: 'Restart Now',
              onClick: () => window.api.updater.quitAndInstall()
            }
          })
        } else if (status.state === 'error' && 'userInitiated' in status && status.userInitiated) {
          toast.error('Could not check for updates.', {
            description: status.message,
            id: checkingToastId
          })
          checkingToastId = undefined
        }
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
