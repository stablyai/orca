import { useAppStore } from '@/store'
import { sendLayoutCommandToOwner } from '@/runtime/layout-owner-command'

type PinnableItem = {
  unifiedTabId: string
  isPinned: boolean
  type?: string
  data?: { id: string }
}

type TabPinActions<Item extends PinnableItem> = {
  togglePinned: (item: Item) => void
  makePreviewFilePermanent: (fileId: string, tabId?: string) => void
}

/**
 * The tab bar's pin in a layout-owner build: main changes its copy and its frame draws the pin.
 * The window's own action runs when main is not asked or a paired server holds the tab. A tab's
 * rename and color go to main from their store actions.
 */
export function withLayoutOwnerTabProps<Item extends PinnableItem>(
  actions: TabPinActions<Item>,
  worktreeId: () => string
): Pick<TabPinActions<Item>, 'togglePinned'> {
  return {
    togglePinned: (item) => {
      const today = (): void => actions.togglePinned(item)
      const command = {
        type: 'setTabProps' as const,
        tabId: item.unifiedTabId,
        isPinned: !item.isPinned
      }
      const shown = (): void => {
        // Preview stays the window's until main opens files (phase C4): pinning a preview keeps it.
        if (!item.isPinned && item.type === 'editor' && item.data) {
          actions.makePreviewFilePermanent(item.data.id, item.unifiedTabId)
        }
        // A pin counts as a use of terminal tabs, as the window's own pin does.
        void useAppStore.getState().recordFeatureInteraction?.('terminal-tabs')
      }
      if (
        !sendLayoutCommandToOwner(worktreeId(), command, {
          apply: shown,
          asToday: today
        })
      ) {
        today()
      }
    }
  }
}
