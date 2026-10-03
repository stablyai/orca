import type { TabClusterColor } from '../../../../shared/tab-types'
import type { TabStripSelection } from '@/store/slices/tabs/tabs-slice-contract'

export type TabStripActivationModifiers = {
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
}

export type TabStripInteractionProps = {
  clusterColor?: TabClusterColor
  isHighlighted?: boolean
  onSelect?: (modifiers: TabStripActivationModifiers) => boolean
}

export function resolveTabStripSelection({
  visibleTabIds,
  activeTabId,
  selection,
  clickedTabId,
  modifiers,
  isMac
}: {
  visibleTabIds: readonly string[]
  activeTabId: string | null
  selection: TabStripSelection | null | undefined
  clickedTabId: string
  modifiers: TabStripActivationModifiers
  isMac: boolean
}): { selection: TabStripSelection | null; activate: boolean } {
  if (modifiers.shiftKey) {
    const anchor =
      [selection?.anchorTabId, activeTabId, clickedTabId].find(
        (id): id is string => typeof id === 'string' && visibleTabIds.includes(id)
      ) ?? clickedTabId
    const anchorIndex = visibleTabIds.indexOf(anchor)
    const clickedIndex = visibleTabIds.indexOf(clickedTabId)
    return {
      selection: {
        tabIds:
          anchorIndex === -1 || clickedIndex === -1
            ? [clickedTabId]
            : visibleTabIds.slice(
                Math.min(anchorIndex, clickedIndex),
                Math.max(anchorIndex, clickedIndex) + 1
              ),
        anchorTabId: anchor
      },
      activate: false
    }
  }
  if (isMac ? modifiers.metaKey : modifiers.ctrlKey) {
    const tabIds = new Set(selection?.tabIds)
    if (tabIds.size === 0 && activeTabId) {
      tabIds.add(activeTabId)
    }
    if (tabIds.has(clickedTabId)) {
      tabIds.delete(clickedTabId)
    } else {
      tabIds.add(clickedTabId)
    }
    return {
      selection: { tabIds: [...tabIds], anchorTabId: clickedTabId },
      activate: false
    }
  }
  return { selection: null, activate: true }
}
