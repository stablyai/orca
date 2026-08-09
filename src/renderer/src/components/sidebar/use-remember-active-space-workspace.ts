import { useEffect, useRef } from 'react'
import { useAppStore } from '@/store'
import { isWorkspaceKey, worktreeWorkspaceKey } from '../../../../shared/workspace-scope'

export function useRememberActiveSpaceWorkspace(): void {
  const activeSpaceId = useAppStore((s) => s.activeSpaceId)
  const activeWorkspaceKey = useAppStore((s) => s.activeWorkspaceKey)
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const activeWorkspaceExecutionHostId = useAppStore((s) => s.activeWorkspaceExecutionHostId)
  const rememberSpaceWorkspaceKey = useAppStore((s) => s.rememberSpaceWorkspaceKey)
  const lastSpaceIdRef = useRef(activeSpaceId)

  useEffect(() => {
    const switched = lastSpaceIdRef.current !== activeSpaceId
    lastSpaceIdRef.current = activeSpaceId
    // Avoid recording the previous Space's workspace during a switch.
    if (switched) {
      return
    }
    const candidate =
      activeWorkspaceKey && isWorkspaceKey(activeWorkspaceKey)
        ? activeWorkspaceKey
        : activeWorktreeId
          ? worktreeWorkspaceKey(activeWorktreeId)
          : null
    if (candidate) {
      rememberSpaceWorkspaceKey(activeSpaceId, candidate, activeWorkspaceExecutionHostId)
    }
  }, [
    activeSpaceId,
    activeWorkspaceExecutionHostId,
    activeWorkspaceKey,
    activeWorktreeId,
    rememberSpaceWorkspaceKey
  ])
}
