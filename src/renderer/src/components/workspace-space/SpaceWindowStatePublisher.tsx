import { useEffect } from 'react'
import { useAppStore } from '@/store'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { pickSpaceWindowState, spaceWindowStateChanged } from './space-window-state'
import { revealWorkspaceSpaceChange } from '../status-bar/workspace-space-open-change'

export function SpaceWindowStatePublisher(): null {
  useEffect(() => {
    const api = window.api.workspaceSpace
    if (!api.publishWindowState || !api.onWindowStateRequested) {
      return
    }
    let windowOpen = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let offStore: (() => void) | null = null
    const publish = (): void => {
      timer = null
      if (windowOpen) {
        void api.publishWindowState?.(pickSpaceWindowState(useAppStore.getState()))
      }
    }
    const queuePublish = (): void => {
      if (windowOpen && timer === null) {
        timer = setTimeout(publish, 100)
      }
    }
    const offRequest = api.onWindowStateRequested(() => {
      windowOpen = true
      offStore ??= useAppStore.subscribe((next, previous) => {
        if (spaceWindowStateChanged(previous, next)) {
          queuePublish()
        }
      })
      publish()
    })
    const offClose = api.onWindowClosed?.(() => {
      windowOpen = false
      offStore?.()
      offStore = null
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
    })
    const offReveal = api.onRevealWorktree?.((worktreeId, executionHostId, change) => {
      if (change) {
        void revealWorkspaceSpaceChange(worktreeId, executionHostId, change)
        return
      }
      activateAndRevealWorktree(worktreeId, { navigationIntent: 'user-open', executionHostId })
    })
    const offRefresh = api.onWorktreeRefreshRequested?.(() => {
      void useAppStore.getState().fetchAllWorktrees()
    })
    const offAnalysis = api.onWindowAnalysis?.((analysis) => {
      if (typeof analysis.scannedAt === 'number') {
        useAppStore.setState({ workspaceSpaceAnalysis: analysis })
      }
    })
    return () => {
      if (timer !== null) {
        clearTimeout(timer)
      }
      offStore?.()
      offRequest()
      offClose?.()
      offReveal?.()
      offRefresh?.()
      offAnalysis?.()
    }
  }, [])
  return null
}
