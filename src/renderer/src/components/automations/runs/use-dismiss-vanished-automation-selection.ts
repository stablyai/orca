import { useEffect } from 'react'
import type { AutomationsPageListState } from '../listing/use-automations-page-list-state'
import type { AutomationsPageLocalState } from '../use-automations-page-local-state'
import type { AutomationsPageSetupState } from '../authoring/use-automations-page-setup-state'
import type { AutomationsPageStoreState } from '../use-automations-page-store-state'

type DismissVanishedAutomationSelectionInput = Pick<
  AutomationsPageListState,
  'selectedRow' | 'visibleRows' | 'externalAutomationEntries'
> &
  Pick<
    AutomationsPageLocalState,
    | 'isLoading'
    | 'isDetailOpen'
    | 'pageView'
    | 'selectedExternalKey'
    | 'setIsDetailOpen'
    | 'setSelectedAutomationRunPageId'
    | 'setActivePaneTab'
  > &
  Pick<AutomationsPageStoreState, 'pendingAutomationRunNavigation' | 'selectedId'> &
  Pick<AutomationsPageSetupState, 'selectedAutomationRunPage'> & { externalLoading: boolean }

/** Closes the detail pane once its selected automation is no longer listed. */
export function useDismissVanishedAutomationSelection({
  isLoading,
  externalLoading,
  isDetailOpen,
  pendingAutomationRunNavigation,
  pageView,
  selectedAutomationRunPage,
  selectedRow,
  visibleRows,
  selectedId,
  selectedExternalKey,
  externalAutomationEntries,
  setIsDetailOpen,
  setSelectedAutomationRunPageId,
  setActivePaneTab
}: DismissVanishedAutomationSelectionInput): void {
  useEffect(() => {
    if (
      isLoading ||
      externalLoading ||
      !isDetailOpen ||
      pendingAutomationRunNavigation ||
      (pageView === 'run' && selectedAutomationRunPage)
    ) {
      return
    }
    const hasSelectedLocal = selectedRow?.key
      ? visibleRows.some((row) => row.key === selectedRow.key)
      : selectedId !== null && selectedRow !== null
    const hasSelectedExternal =
      selectedExternalKey !== null &&
      externalAutomationEntries.some((entry) => entry.key === selectedExternalKey)
    if (hasSelectedLocal || hasSelectedExternal) {
      return
    }
    setIsDetailOpen(false)
    setSelectedAutomationRunPageId(null)
    setActivePaneTab('overview')
  }, [
    isLoading,
    externalLoading,
    isDetailOpen,
    pageView,
    selectedAutomationRunPage,
    externalAutomationEntries,
    visibleRows,
    pendingAutomationRunNavigation,
    selectedExternalKey,
    selectedId,
    selectedRow,
    setActivePaneTab,
    setIsDetailOpen,
    setSelectedAutomationRunPageId
  ])
}
