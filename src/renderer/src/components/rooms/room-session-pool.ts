import { useMemo } from 'react'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import type { AgentSessionOption } from './room-types'

export const shortSessionLabel = (label: string): string => {
  const oneLine =
    label.replace(/\s+/g, ' ').trim() ||
    translate('auto.components.rooms.pool.untitledSession', '(untitled session)')
  return oneLine.length > 40 ? `${oneLine.slice(0, 40)}…` : oneLine
}

/** Every mounted agent-session tab across the open workspaces. */
export function useAgentSessionPool(): AgentSessionOption[] {
  const tabsByWorktree = useAppStore((s) => s.unifiedTabsByWorktree)
  return useMemo(() => {
    const out: AgentSessionOption[] = []
    for (const [worktreeId, tabs] of Object.entries(tabsByWorktree)) {
      for (const tab of tabs) {
        if (tab.contentType === 'agent-session' && tab.entityId) {
          out.push({ sessionId: tab.entityId, label: tab.label || tab.entityId, worktreeId })
        }
      }
    }
    out.sort((a, b) => b.label.localeCompare(a.label))
    return out
  }, [tabsByWorktree])
}
