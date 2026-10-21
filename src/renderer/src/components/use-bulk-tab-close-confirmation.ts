import { useCallback } from 'react'
import { useConfirmationDialog } from './confirmation-dialog-context'
import { translate } from '@/i18n/i18n'

export type BulkTabCloseScope = 'others' | 'right' | 'left' | 'editors'

export function useBulkTabCloseConfirmation() {
  const confirm = useConfirmationDialog()
  return useCallback(
    (
      scope: BulkTabCloseScope,
      selectTabIds: () => string[],
      closeTabs: (tabIds: string[]) => void
    ): void => {
      const selectedIds = new Set(selectTabIds())
      if (selectedIds.size === 0) {
        return
      }
      const titles = {
        others: translate('components.tab.bar.bulkClose.others', 'Close other tabs?'),
        right: translate('components.tab.bar.bulkClose.right', 'Close tabs to the right?'),
        left: translate('components.tab.bar.bulkClose.left', 'Close tabs to the left?'),
        editors: translate('components.tab.bar.bulkClose.editors', 'Close all editor tabs?')
      }
      void confirm({
        title: titles[scope],
        description: translate(
          'components.tab.bar.bulkClose.description',
          'The selected tabs will be closed. Pinned tabs will stay open.'
        ),
        confirmLabel: translate('components.tab.bar.bulkClose.confirm', 'Close tabs'),
        cancelVariant: 'ghost',
        confirmVariant: 'destructive'
      }).then((confirmed) => {
        if (!confirmed) {
          return
        }
        // Remote updates can pin, move, remove or add tabs while the dialog is open.
        const remainingIds = selectTabIds().filter((id) => selectedIds.has(id))
        if (remainingIds.length > 0) {
          closeTabs(remainingIds)
        }
      })
    },
    [confirm]
  )
}
