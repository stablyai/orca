// Desktop and mobile share when bulk tab close asks first and its English wording.

export type BulkTabCloseScope = 'others' | 'right' | 'left' | 'editors'

export const BULK_TAB_CLOSE_COPY = {
  title: {
    others: 'Close other tabs?',
    right: 'Close tabs to the right?',
    left: 'Close tabs to the left?',
    editors: 'Close all editor tabs?'
  },
  description: 'The selected tabs will be closed. Pinned tabs will stay open.',
  confirm: 'Close tabs'
} as const

export async function closeTabsAfterConfirmation(
  selectTabIds: () => string[],
  confirm: () => Promise<boolean>,
  closeTabs: (tabIds: string[]) => void
): Promise<void> {
  const selectedIds = new Set(selectTabIds())
  if (selectedIds.size === 0 || !(await confirm())) {
    return
  }
  // Remote updates can pin, move, remove or add tabs while the dialog is open.
  const remainingIds = selectTabIds().filter((id) => selectedIds.has(id))
  if (remainingIds.length > 0) {
    closeTabs(remainingIds)
  }
}
