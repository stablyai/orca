import { useAppStore } from '@/store'
import { shouldIgnoreStalePanePtyLayoutBinding } from './pane-pty-layout-binding'

/** The PTY id a reattach replaces in the tab/layout, if any. */
export function resolveReattachReplacementPtyId(args: {
  tabId: string
  leafId: string
  ptyId: string
  staleSessionId?: string | null
}): string | undefined {
  const { tabId, leafId, ptyId, staleSessionId } = args
  if (staleSessionId && staleSessionId !== ptyId) {
    return staleSessionId
  }
  const state = useAppStore.getState()
  const currentTabPtyId = Object.values(state.tabsByWorktree)
    .flat()
    .find((tab) => tab.id === tabId)?.ptyId
  const existingLeafPtyId = state.terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId?.[leafId]
  // A split pane has its own PTY while the legacy tab-level field still
  // names the source pane. Only infer a tab-wide replacement when that
  // field is actually bound to this leaf; an unrelated sibling must not be
  // rewritten to the new pane's PTY.
  return currentTabPtyId &&
    shouldIgnoreStalePanePtyLayoutBinding({
      existingPtyId: existingLeafPtyId,
      nextPtyId: ptyId,
      tabPtyId: currentTabPtyId
    })
    ? existingLeafPtyId
    : undefined
}
