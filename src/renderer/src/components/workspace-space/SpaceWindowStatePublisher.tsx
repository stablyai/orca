import { useEffect } from 'react'
import { useAppStore } from '@/store/index'
import { activateAndRevealWorktree } from '@/lib/workspace/activation/worktree-activation'
import {
  pickSpaceWindowState,
  spaceWindowStateChanged,
  type SpaceWindowState
} from './space-window-state'
import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import type { WorkspaceSpaceChange } from '../../../../shared/workspace-disk-space/workspace-space-change'

async function revealWorkspaceSpaceChangeLazy(
  worktreeId: string,
  executionHostId: ExecutionHostId | undefined,
  change: WorkspaceSpaceChange
): Promise<void> {
  const { revealWorkspaceSpaceChange } =
    await import('../status-bar/workspace-storage/table/workspace-space-open-change')
  await revealWorkspaceSpaceChange(worktreeId, executionHostId, change)
}

async function refreshLinkedIssueForWorktreeLazy(
  worktreeId: string,
  executionHostId: ExecutionHostId | undefined
): Promise<void> {
  const { refreshLinkedIssueForWorktree } =
    await import('../status-bar/workspace-storage/decisions/workspace-space-issue-freshness')
  refreshLinkedIssueForWorktree(worktreeId, executionHostId)
}

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
      if (offStore == null) {
        offStore = useAppStore.subscribe((next, previous) => {
          if (spaceWindowStateChanged(previous, next)) {
            queuePublish()
          }
        })
      }
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
        void revealWorkspaceSpaceChangeLazy(worktreeId, executionHostId, change)
        return
      }
      activateAndRevealWorktree(worktreeId, { navigationIntent: 'user-open', executionHostId })
    })
    const offRefresh = api.onWorktreeRefreshRequested?.(() => {
      void useAppStore.getState().fetchAllWorktrees()
    })
    const offIssueRefresh = api.onIssueRefreshRequested?.((worktreeId, executionHostId) => {
      void refreshLinkedIssueForWorktreeLazy(worktreeId, executionHostId)
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
      offIssueRefresh?.()
      offAnalysis?.()
    }
  }, [])
  return null
}
