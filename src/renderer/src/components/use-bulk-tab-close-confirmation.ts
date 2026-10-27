import { useCallback } from 'react'
import { useConfirmationDialog } from './confirmation-dialog-context'
import { translate } from '@/i18n/i18n'
import {
  BULK_TAB_CLOSE_COPY as COPY,
  closeTabsAfterConfirmation,
  type BulkTabCloseScope
} from '../../../shared/bulk-tab-close-confirmation'

export function useBulkTabCloseConfirmation() {
  const confirm = useConfirmationDialog()
  return useCallback(
    (
      scope: BulkTabCloseScope,
      selectTabIds: () => string[],
      closeTabs: (tabIds: string[]) => void
    ): void => {
      void closeTabsAfterConfirmation(
        selectTabIds,
        () => {
          const titles = {
            others: translate('components.tab.bar.bulkClose.others', COPY.title.others),
            right: translate('components.tab.bar.bulkClose.right', COPY.title.right),
            left: translate('components.tab.bar.bulkClose.left', COPY.title.left),
            editors: translate('components.tab.bar.bulkClose.editors', COPY.title.editors)
          }
          return confirm({
            title: titles[scope],
            description: translate('components.tab.bar.bulkClose.description', COPY.description),
            confirmLabel: translate('components.tab.bar.bulkClose.confirm', COPY.confirm),
            cancelVariant: 'ghost',
            confirmVariant: 'destructive'
          })
        },
        closeTabs
      )
    },
    [confirm]
  )
}
