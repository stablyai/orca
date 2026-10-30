import { useEffect } from 'react'
import { useAppStore } from '@/store'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import {
  pickSpaceWindowState,
  spaceWindowStateChanged,
  type SpaceWindowState
} from './space-window-state'
import { revealWorkspaceSpaceChange } from '../status-bar/workspace-space-open-change'

export function SpaceWindowStatePublisher(): null {
  useEffect(() => {
    const api = window.api.workspaceSpace
    if (!api.publishWindowState || !api.onWindowStateRequested) {
      return
    }
    const publishWindowState = api.publishWindowState
    let windowOpen = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let offStore: (() => void) | null = null
    let lastPublishedDrafts: SpaceWindowState['editorDrafts'] | null = null
    const publish = (includeDrafts = false): void => {
      if (timer !== null) {
        clearTimeout(timer)
      }
      timer = null
      if (windowOpen) {
        const state = pickSpaceWindowState(useAppStore.getState())
        const { editorDrafts, ...withoutDrafts } = state
        const update = includeDrafts || editorDrafts !== lastPublishedDrafts ? state : withoutDrafts
        lastPublishedDrafts = editorDrafts
        void publishWindowState(update).catch(() => {
          lastPublishedDrafts = null
        })
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
      publish(true)
    })
    const offClose = api.onWindowClosed?.(() => {
      windowOpen = false
      lastPublishedDrafts = null
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
