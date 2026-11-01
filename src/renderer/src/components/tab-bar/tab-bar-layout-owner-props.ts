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

/** Let main draw local pin changes; retain window actions for unsupported or paired-host ownership. */
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
        // Pinning must make preview files permanent while file-open ownership remains in the window.
        if (!item.isPinned && item.type === 'editor' && item.data) {
          actions.makePreviewFilePermanent(item.data.id, item.unifiedTabId)
        }
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
