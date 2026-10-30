import type { AutomationListViewItem } from './automation-list-view'
import type { AutomationPaneTab } from './automation-page-state'

export type AutomationListArrowKey = 'ArrowUp' | 'ArrowDown'

export function isAutomationListArrowKey(key: string): key is AutomationListArrowKey {
  return key === 'ArrowUp' || key === 'ArrowDown'
}

export function shouldHandleAutomationListSearchArrowKey(event: {
  key: string
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  nativeEvent: { isComposing: boolean }
}): boolean {
  return (
    isAutomationListArrowKey(event.key) &&
    !event.nativeEvent.isComposing &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey
  )
}

export function shouldHandleAutomationListSearchEnterKey(event: {
  key: string
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  nativeEvent: { isComposing: boolean }
}): boolean {
  return (
    event.key === 'Enter' &&
    !event.nativeEvent.isComposing &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey
  )
}

export function findAutomationListSelectionIndex(
  items: readonly Pick<AutomationListViewItem, 'id' | 'kind'>[],
  selectedId: string | null,
  selectedExternalKey: string | null
): number {
  if (selectedExternalKey !== null) {
    return items.findIndex((item) => item.kind === 'external' && item.id === selectedExternalKey)
  }
  if (selectedId != null) {
    return items.findIndex((item) => item.kind === 'local' && item.id === selectedId)
  }
  return -1
}

export function getAutomationListArrowNavigationTarget(args: {
  items: readonly Pick<AutomationListViewItem, 'id' | 'kind'>[]
  selectedId: string | null
  selectedExternalKey: string | null
  key: AutomationListArrowKey
}): Pick<AutomationListViewItem, 'id' | 'kind'> | null {
  const { items, selectedId, selectedExternalKey, key } = args
  if (items.length === 0) {
    return null
  }
  const currentIndex = findAutomationListSelectionIndex(items, selectedId, selectedExternalKey)
  if (currentIndex < 0) {
    return items[key === 'ArrowDown' ? 0 : items.length - 1] ?? null
  }
  const nextIndex = key === 'ArrowDown' ? currentIndex + 1 : currentIndex - 1
  if (nextIndex < 0 || nextIndex >= items.length) {
    return items[currentIndex] ?? null
  }
  return items[nextIndex] ?? null
}

export function getAutomationListEnterNavigationTarget(args: {
  items: readonly Pick<AutomationListViewItem, 'id' | 'kind'>[]
  selectedId: string | null
  selectedExternalKey: string | null
}): Pick<AutomationListViewItem, 'id' | 'kind'> | null {
  const { items, selectedId, selectedExternalKey } = args
  if (items.length === 0) {
    return null
  }
  const currentIndex = findAutomationListSelectionIndex(items, selectedId, selectedExternalKey)
  if (currentIndex >= 0) {
    return items[currentIndex] ?? null
  }
  return items[0] ?? null
}

export function activateAutomationListEnterTarget(args: {
  items: readonly Pick<AutomationListViewItem, 'id' | 'kind'>[]
  selectedId: string | null
  selectedExternalKey: string | null
  selectAutomationRow: (rowKey: string | null) => void
  selectExternalKey: (externalKey: string | null) => void
  setActivePaneTab: (tab: AutomationPaneTab) => void
  onOpenDetail: () => void
}): void {
  const target = getAutomationListEnterNavigationTarget(args)
  if (!target) {
    return
  }
  if (target.kind === 'local') {
    args.selectExternalKey(null)
    args.selectAutomationRow(target.id)
  } else {
    args.selectAutomationRow(null)
    args.selectExternalKey(target.id)
    args.setActivePaneTab('overview')
  }
  args.onOpenDetail()
}

export function createAutomationListEnterHandler(
  args: Parameters<typeof activateAutomationListEnterTarget>[0]
): () => void {
  return () => activateAutomationListEnterTarget(args)
}
