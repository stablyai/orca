import { useMemo } from 'react'
import { useAppStore } from '@/store'

/** Rows the sidebar lists despite its filters: the agent send target and the workspace last opened from Cmd+J. */
export function useForcedVisibleWorktreeIds(
  agentSendTargetWorktreeId: string | null
): readonly string[] | undefined {
  const jumpedWorktreeId = useAppStore((s) => s.sidebarJumpedWorktreeId)
  return useMemo(() => {
    const ids = [agentSendTargetWorktreeId, jumpedWorktreeId].filter(
      (id): id is string => id !== null
    )
    return ids.length > 0 ? ids : undefined
  }, [agentSendTargetWorktreeId, jumpedWorktreeId])
}
