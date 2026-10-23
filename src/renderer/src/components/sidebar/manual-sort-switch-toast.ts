import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { SORT_OPTIONS } from './sidebar-workspace-option-items'

const MANUAL_SORT_SWITCH_TOAST_ID = 'sidebar-manual-sort-switch'

// Why: a drop that reorders must switch to Manual so the placement sticks; say so, since it changes a shared setting.
export function switchSortToManualAfterDrop(): void {
  const { sortBy: previousSortBy, setSortBy } = useAppStore.getState()
  if (previousSortBy === 'manual') {
    return
  }
  setSortBy('manual')

  // Why: any later sort change makes "Back to …" stale, so retire the toast instead of letting it clobber that choice.
  let retired = false
  const retire = (): void => {
    retired = true
    unsubscribe()
  }
  const unsubscribe = useAppStore.subscribe((state, prev) => {
    if (state.sortBy !== prev.sortBy) {
      retire()
      toast.dismiss(MANUAL_SORT_SWITCH_TOAST_ID)
    }
  })
  const previousLabel = SORT_OPTIONS.find((option) => option.id === previousSortBy)?.label
  toast.info(
    translate('auto.components.sidebar.manualSortSwitch.title', 'Sort changed to Manual'),
    {
      id: MANUAL_SORT_SWITCH_TOAST_ID,
      description: translate(
        'auto.components.sidebar.manualSortSwitch.description',
        'Manual keeps workspaces where you drop them.'
      ),
      duration: 8000,
      onDismiss: retire,
      onAutoClose: retire,
      action: previousLabel
        ? {
            label: translate(
              'auto.components.sidebar.manualSortSwitch.restore',
              'Back to {{label}}',
              {
                label: previousLabel
              }
            ),
            // The sortBy change retires the toast through the subscription above.
            onClick: () => {
              if (!retired) {
                setSortBy(previousSortBy)
              }
            }
          }
        : undefined
    }
  )
}
