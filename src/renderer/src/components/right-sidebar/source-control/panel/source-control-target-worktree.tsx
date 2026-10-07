import { createContext, useCallback, useContext, useEffect, useMemo, useRef } from 'react'
import { useAppStore } from '@/store'
import type { Worktree } from '../../../../../../shared/worktree/types'

type SourceControlTarget = { worktree: Worktree | null; isActive: boolean }

const SourceControlTargetContext = createContext<SourceControlTarget | null>(null)

export function SourceControlTargetProvider({
  worktree,
  isActive,
  children
}: SourceControlTarget & { children: React.ReactNode }): React.JSX.Element {
  const value = useMemo(() => ({ worktree, isActive }), [worktree, isActive])
  return (
    <SourceControlTargetContext.Provider value={value}>
      {children}
    </SourceControlTargetContext.Provider>
  )
}

/** Worktree pinned by an enclosing lineage section; null means follow the active worktree. */
export function useSourceControlTargetWorktree(): SourceControlTarget | null {
  return useContext(SourceControlTargetContext)
}

/**
 * Stable predicate: is this worktree the one the panel shows right now — the pinned target while its
 * section is mounted, otherwise the store's active worktree.
 */
export function useIsSourceControlPanelWorktree(): (worktreeId: string | null) => boolean {
  const target = useSourceControlTargetWorktree()
  const pinnedRef = useRef(target)
  pinnedRef.current = target
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])
  return useCallback((worktreeId) => {
    const pinned = pinnedRef.current
    if (!pinned) {
      return useAppStore.getState().activeWorktreeId === worktreeId
    }
    return mountedRef.current && pinned.worktree !== null && pinned.worktree.id === worktreeId
  }, [])
}
