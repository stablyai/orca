import type { AutomationListViewItem } from './automation-list-view'

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
