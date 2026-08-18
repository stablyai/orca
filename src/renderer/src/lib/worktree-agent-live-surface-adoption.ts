import { parsePaneKey } from '../../../shared/stable-pane-id'
import type { useAppStore } from '@/store'

type LiveSurfaceAdoptionStore = Pick<
  ReturnType<typeof useAppStore.getState>,
  | 'createTab'
  | 'ptyIdsByTabId'
  | 'tabsByWorktree'
  | 'terminalLayoutsByTabId'
  | 'updateTabPtyId'
  | 'replaceTerminalLayoutPanePtyId'
>

function layoutContainsLeaf(
  root: LiveSurfaceAdoptionStore['terminalLayoutsByTabId'][string]['root'],
  leafId: string
): boolean {
  if (!root) {
    return false
  }
  return root.type === 'leaf'
    ? root.leafId === leafId
    : layoutContainsLeaf(root.first, leafId) || layoutContainsLeaf(root.second, leafId)
}

export function bindLivePtyToExactSurface(
  store: LiveSurfaceAdoptionStore,
  worktreeId: string,
  terminal: { paneKey: string; ptyId: string; tabId: string }
): boolean {
  const pane = parsePaneKey(terminal.paneKey)
  if (!pane || pane.tabId !== terminal.tabId) {
    return false
  }
  const ownerEntries = Object.entries(store.tabsByWorktree).flatMap(([ownerWorktreeId, tabs]) =>
    tabs.filter((tab) => tab.id === terminal.tabId).map((tab) => ({ ownerWorktreeId, tab }))
  )
  const competingBinding = Object.entries(store.ptyIdsByTabId).some(
    ([tabId, ptyIds]) => tabId !== terminal.tabId && ptyIds.includes(terminal.ptyId)
  )
  if (ownerEntries.length > 1 || competingBinding) {
    return false
  }
  const existing = ownerEntries[0]
  if (existing) {
    const layout = store.terminalLayoutsByTabId[terminal.tabId]
    if (
      existing.ownerWorktreeId !== worktreeId ||
      !layoutContainsLeaf(layout?.root ?? null, pane.leafId)
    ) {
      return false
    }
    store.updateTabPtyId(terminal.tabId, terminal.ptyId)
    store.replaceTerminalLayoutPanePtyId(terminal.tabId, pane.leafId, terminal.ptyId)
    return true
  }
  const created = store.createTab(worktreeId, undefined, undefined, {
    id: terminal.tabId,
    initialLeafId: pane.leafId,
    initialPtyId: terminal.ptyId,
    activate: false,
    recordInteraction: false
  })
  return created.id === terminal.tabId
}
