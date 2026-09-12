import { useCallback, useState } from 'react'
import { useAppStore } from '@/store'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import { useTabGroupTabCloseCommands } from '../tab-group/useTabGroupTabCloseCommands'
import type { CanvasDocument } from './agent-canvas-document'
import type { Tab } from '../../../../shared/tab-types'
import { canvasResourceTab } from './canvas-resource-tabs'

const EMPTY_TABS: Tab[] = []

export function useCanvasNodeRemoval(
  canvas: Tab,
  document: CanvasDocument,
  readOnly: boolean,
  detach: (id: string) => void
) {
  const [pendingId, setPendingId] = useState<string | null>(null)
  const tabs = useAppStore((state) => state.unifiedTabsByWorktree[canvas.worktreeId] ?? EMPTY_TABS)
  const { closeItem } = useTabGroupTabCloseCommands({
    worktreeId: canvas.worktreeId,
    groupTabs: tabs
  })
  const node = document.nodes.find((item) => item.id === pendingId) ?? null
  const tab = node
    ? canvasResourceTab(
        node,
        canvas,
        tabs,
        getExecutionHostIdForWorktree(useAppStore.getState(), canvas.worktreeId)
      )
    : undefined
  const request = useCallback(
    (id: string) => {
      if (!readOnly) {
        setPendingId(id)
      }
    },
    [readOnly]
  )
  return {
    request,
    node,
    tab,
    onCancel: () => setPendingId(null),
    onDetach: () => {
      if (node && !readOnly) {
        detach(node.id)
      }
      setPendingId(null)
    },
    onCloseTab: () => {
      if (!node || !tab || readOnly) {
        return
      }
      const current = canvasResourceTab(
        node,
        canvas,
        useAppStore.getState().unifiedTabsByWorktree[canvas.worktreeId] ?? [],
        getExecutionHostIdForWorktree(useAppStore.getState(), canvas.worktreeId)
      )
      if (
        !current ||
        current.id !== tab.id ||
        current.createdAt !== tab.createdAt ||
        current.isPinned
      ) {
        return
      }
      setPendingId(null)
      // The normal tab-close flow keeps its running-process confirmation and host routing.
      closeItem(current.id)
    }
  }
}
