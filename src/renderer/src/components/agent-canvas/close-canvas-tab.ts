import { toast } from 'sonner'
import type { Tab } from '../../../../shared/tab-types'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { clearClosedCanvasContext } from './canvas-context-sync'

const pending = new Map<string, Promise<boolean>>()

export function closeCanvasTab(tab: Tab, onClosed?: () => void): Promise<boolean> {
  if (tab.contentType !== 'canvas' || tab.isPinned) {
    return Promise.resolve(false)
  }
  const key = JSON.stringify([tab.executionHostId, tab.worktreeId, tab.id, tab.createdAt])
  const existing = pending.get(key)
  if (existing) {
    return existing
  }
  const operation = clearClosedCanvasContext(tab)
    .then(() => {
      const state = useAppStore.getState()
      const current = state.unifiedTabsByWorktree[tab.worktreeId]?.find(
        (item) => item.id === tab.id
      )
      if (
        !current ||
        current.isPinned ||
        current.createdAt !== tab.createdAt ||
        current.executionHostId !== tab.executionHostId
      ) {
        return false
      }
      state.closeUnifiedTab(tab.id)
      onClosed?.()
      return true
    })
    .catch((error: unknown) => {
      toast.error(translate('agentCanvas.closeContextFailed', 'Could not remove canvas context'), {
        description: error instanceof Error ? error.message : String(error)
      })
      return false
    })
    .finally(() => pending.delete(key))
  pending.set(key, operation)
  return operation
}
