import { useCallback } from 'react'
import { useAppStore } from '@/store'

export function useShowVisibleEditorTab(
  activeWorktreeId: string | null | undefined,
  activeEditorGroupId: string | undefined
): (fileId: string, contentType: 'editor' | 'diff', label: string) => void {
  return useCallback(
    (fileId: string, contentType: 'editor' | 'diff', label: string) => {
      if (!activeWorktreeId) {
        return
      }
      const state = useAppStore.getState()
      const existing = state.unifiedTabsByWorktree?.[activeWorktreeId]?.find(
        (tab) => tab.entityId === fileId && tab.contentType === contentType
      )
      if (existing) {
        state.activateTab(existing.id, { worktreeId: activeWorktreeId })
        return
      }
      state.createUnifiedTab(activeWorktreeId, contentType, {
        entityId: fileId,
        label,
        targetGroupId: activeEditorGroupId,
        activate: true
      })
    },
    [activeEditorGroupId, activeWorktreeId]
  )
}
