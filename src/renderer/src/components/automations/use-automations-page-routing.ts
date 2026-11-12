import { useEffect } from 'react'
import type { AutomationsPageLocation } from './automation-page-state'
import { automationRowHostId } from './automations-page-navigation'
import {
  isAutomationRunNowListed,
  isAutomationRunNowPending
} from './runs/automation-run-now-pending'
import type { AutomationsPageController } from './use-automations-page-controller'
import {
  useAutomationsPageFocus,
  useAutomationsPageHistory,
  type AutomationsPageFocusTarget
} from './use-automations-page-history'

// A Run now request whose run never shows up (history read failed) must not lock the button.
const RUN_NOW_PENDING_MAX_MS = 20_000

// JSON string quoting is valid CSS string quoting for the ids and keys used here.
function attributeSelector(name: string, value: string): string {
  return `[${name}=${JSON.stringify(value)}]`
}

/** Page identity for back/forward history and focus, plus the Run now busy state. */
export function useAutomationsPageRouting(
  controller: AutomationsPageController,
  mainRef: React.RefObject<HTMLElement | null>
): { isRunNowPending: boolean } {
  const { store, local, list, setup, navigation } = controller
  const {
    isLoading,
    pageView,
    runPageOrigin,
    runNotFound,
    runNowPending,
    setRunNowPending,
    isDetailOpen,
    activePaneTab
  } = local
  const { selected, selectedRow, selectedExternal } = list
  const selectedAutomationRunPage = setup.selectedAutomationRunPage

  // Run now stays busy until its run is listed; a run already in progress never blocks it.
  const runNowListed =
    runNowPending !== null && isAutomationRunNowListed(runNowPending, setup.selectedRuns)
  const isRunNowPending = isAutomationRunNowPending(
    runNowPending,
    selectedRow?.key,
    setup.selectedRuns
  )
  useEffect(() => {
    if (!runNowPending) {
      return
    }
    if (runNowListed) {
      setRunNowPending(null)
      return
    }
    if (runNowPending.acknowledgedAt === null) {
      return
    }
    const timer = setTimeout(
      () => setRunNowPending(null),
      Math.max(0, runNowPending.acknowledgedAt + RUN_NOW_PENDING_MAX_MS - Date.now())
    )
    return () => clearTimeout(timer)
  }, [runNowListed, runNowPending, setRunNowPending])

  const selectedHostId = automationRowHostId(selectedRow)
  const isResolving =
    Boolean(store.pendingAutomationRunNavigation) ||
    isLoading ||
    (local.selectedExternalKey !== null && list.scopedExternal.loading)
  const location: AutomationsPageLocation | null = isResolving
    ? null
    : pageView === 'runs'
      ? { page: 'runs' }
      : pageView === 'run'
        ? selected && selectedAutomationRunPage && !runNotFound
          ? {
              page: 'run',
              automationId: selected.id,
              runId: selectedAutomationRunPage.id,
              hostId: selectedHostId,
              origin: runPageOrigin
            }
          : null
        : isDetailOpen && selectedExternal
          ? { page: 'external', externalKey: selectedExternal.key }
          : isDetailOpen && selected
            ? {
                page: activePaneTab === 'runs' ? 'automationRuns' : 'detail',
                automationId: selected.id,
                hostId: selectedHostId
              }
            : isDetailOpen
              ? null
              : { page: 'list' }
  useAutomationsPageHistory({ location, navigation })

  const focusTarget: AutomationsPageFocusTarget | null = runNotFound
    ? { key: 'not-found', page: 'not-found', parents: [], returnSelector: null }
    : !location
      ? null
      : location.page === 'run'
        ? {
            key: `run:${location.runId}`,
            page: 'run',
            parents: ['detail', 'automationRuns', 'runs'],
            returnSelector: attributeSelector('data-automation-run-id', location.runId)
          }
        : location.page === 'detail' || location.page === 'automationRuns'
          ? {
              key: `${location.page}:${selectedRow?.key ?? location.automationId}`,
              page: location.page,
              parents: location.page === 'automationRuns' ? ['detail', 'list'] : ['list'],
              returnSelector:
                location.page === 'automationRuns'
                  ? '[data-automation-all-runs]'
                  : selectedRow
                    ? attributeSelector('data-automation-row-id', selectedRow.key)
                    : null
            }
          : location.page === 'external'
            ? {
                key: `external:${location.externalKey}`,
                page: 'external',
                parents: ['list'],
                returnSelector: attributeSelector(
                  'data-automation-external-id',
                  location.externalKey
                )
              }
            : { key: location.page, page: location.page, parents: [], returnSelector: null }
  useAutomationsPageFocus(focusTarget, mainRef)

  return { isRunNowPending }
}
