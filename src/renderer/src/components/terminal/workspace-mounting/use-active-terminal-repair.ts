import { useEffect } from 'react'
import type { WorkspaceVisibleTabType } from '../../../../../shared/workspace-layout/tab-groups/tab-types'
import type { TerminalTab } from '../../../../../shared/workspace-layout/terminal-tab-types'
import { resolveRepairedActiveTerminalTabId } from './active-terminal-repair'
import { useAppStore } from '@/store/index'
import { foldedWorkerTerminalIds } from '../../tab-bar/worker-tab-folding'

const EMPTY_FOLDED: ReadonlySet<string> = new Set()

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
  const state = useAppStore.getState()
  const groupId =
    renderedActiveWorktreeId && state.activeGroupIdByWorktree[renderedActiveWorktreeId]
  const group =
    renderedActiveWorktreeId &&
    state.groupsByWorktree[renderedActiveWorktreeId]?.find((group) => group.id === groupId)
  if (group && group.activeTabId === null) {
    return false
  }
  const rememberedTabId =
    renderedActiveWorktreeId !== null &&
    Object.hasOwn(activeTabIdByWorktree, renderedActiveWorktreeId)
      ? (activeTabIdByWorktree[renderedActiveWorktreeId] ?? null)
      : null
  // Repair never reselects a folded worker; a pane of only folded workers stays on its landing.
  const folded =
    renderedActiveWorktreeId === null
      ? EMPTY_FOLDED
      : foldedWorkerTerminalIds(useAppStore.getState(), renderedActiveWorktreeId)
  const repairedTabId = resolveRepairedActiveTerminalTabId({
    activeTabType,
    activeTabId,
    rememberedTabId: rememberedTabId && folded.has(rememberedTabId) ? null : rememberedTabId,
    tabs: folded.size === 0 ? tabs : tabs.filter((tab) => !folded.has(tab.id))
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
