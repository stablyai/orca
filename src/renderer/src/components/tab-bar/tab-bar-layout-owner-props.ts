import { sendLayoutCommandToOwner } from '@/runtime/layout-owner-command'

type TabPinActions<Item extends { unifiedTabId: string; isPinned: boolean }> = {
  togglePinned: (item: Item) => void
}

/**
 * The tab bar's pin in a layout-owner build: main changes its copy first, then the window's own
 * action shows the same change. The window's action runs alone when main is not asked: a paired
 * server owns the workspace. A tab's rename and color go to main from their store actions.
 */
export function withLayoutOwnerTabProps<Item extends { unifiedTabId: string; isPinned: boolean }>(
  actions: TabPinActions<Item>,
  worktreeId: () => string
): TabPinActions<Item> {
  return {
    togglePinned: (item) => {
      const today = (): void => actions.togglePinned(item)
      const command = {
        type: 'setTabProps' as const,
        tabId: item.unifiedTabId,
        isPinned: !item.isPinned
      }
      if (!sendLayoutCommandToOwner(worktreeId(), command, { apply: today, asToday: today })) {
        today()
      }
    }
  }
}
