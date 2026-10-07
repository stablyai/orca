import { createContext, useContext, useMemo } from 'react'
import type { Worktree } from '../../../../../shared/worktree/types'

type ChecksPanelTarget = { worktree: Worktree | null; isActive: boolean }

const ChecksPanelTargetContext = createContext<ChecksPanelTarget | null>(null)

export function ChecksPanelTargetProvider({
  worktree,
  isActive,
  children
}: ChecksPanelTarget & { children: React.ReactNode }): React.JSX.Element {
  const value = useMemo(() => ({ worktree, isActive }), [worktree, isActive])
  return (
    <ChecksPanelTargetContext.Provider value={value}>{children}</ChecksPanelTargetContext.Provider>
  )
}

/** Worktree pinned by an enclosing lineage section; null means follow the active worktree. */
export function useChecksPanelTargetWorktree(): ChecksPanelTarget | null {
  return useContext(ChecksPanelTargetContext)
}
