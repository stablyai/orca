import { useEffect } from 'react'
import type { WorkspaceVisibleTabType } from '../../../../shared/tab-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { resolveRepairedActiveTerminalTabId } from './active-terminal-repair'

type ActiveTerminalRepairInput = {
  activeTabType: WorkspaceVisibleTabType
  activeTabId: string | null
  activeTabIdByWorktree: Record<string, string | null>
  renderedActiveWorktreeId: string | null
  setActiveTab: (tabId: string) => void
  tabs: TerminalTab[]
}

export function repairActiveTerminalTab({
  activeTabType,
  activeTabId,
  activeTabIdByWorktree,
  renderedActiveWorktreeId,
  setActiveTab,
  tabs
}: ActiveTerminalRepairInput): boolean {
  const rememberedTabId =
    renderedActiveWorktreeId !== null &&
    Object.hasOwn(activeTabIdByWorktree, renderedActiveWorktreeId)
      ? (activeTabIdByWorktree[renderedActiveWorktreeId] ?? null)
      : null
  const repairedTabId = resolveRepairedActiveTerminalTabId({
    activeTabType,
    activeTabId,
    rememberedTabId,
    tabs
  })
  if (!repairedTabId) {
    return false
  }
  setActiveTab(repairedTabId)
  return true
}

export function useActiveTerminalRepair(input: ActiveTerminalRepairInput): void {
  const {
    activeTabId,
    activeTabIdByWorktree,
    activeTabType,
    renderedActiveWorktreeId,
    setActiveTab,
    tabs
  } = input
  useEffect(() => {
    repairActiveTerminalTab({
      activeTabId,
      activeTabIdByWorktree,
      activeTabType,
      renderedActiveWorktreeId,
      setActiveTab,
      tabs
    })
    // Why: `tabs` is the dependency so repair reacts to order/content changes, not just scalar ids.
  }, [
    activeTabId,
    activeTabType,
    setActiveTab,
    tabs,
    activeTabIdByWorktree,
    renderedActiveWorktreeId
  ])
}
