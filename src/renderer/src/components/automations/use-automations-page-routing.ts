import { useEffect } from 'react'
import type { AutomationRunNotFound, AutomationsPageLocation } from './automation-page-state'
import { automationRowHostId } from './automations-page-navigation'
import {
  isAutomationRunNowListed,
  isAutomationRunNowPending,
  settleAutomationRunNowPending
} from './runs/automation-run-now-pending'
import type { AutomationsPageController } from './use-automations-page-controller'
import {
  useAutomationsPageFocus,
  useAutomationsPageHistory,
  type AutomationsPageFocusTarget
} from './use-automations-page-history'

// A Run now request whose run never shows up (history read failed) must not lock the button.
const RUN_NOW_PENDING_MAX_MS = 20_000
// A dispatch that has not answered at all is released after this long.
const RUN_NOW_DISPATCH_MAX_MS = 60_000

// JSON string quoting is valid CSS string quoting for the ids and keys used here.
function attributeSelector(name: string, value: string): string {
  return `[${name}=${JSON.stringify(value)}]`
}

/** A missing destination is still where the user went; replaying it shows not-found again. */
export function automationsPageNotFoundLocation(
  notFound: AutomationRunNotFound
): AutomationsPageLocation {
  return notFound.runId
    ? {
        page: 'run',
        automationId: notFound.automationId,
        runId: notFound.runId,
        hostId: notFound.hostId,
        origin: notFound.origin ?? 'automation'
      }
    : { page: 'detail', automationId: notFound.automationId, hostId: notFound.hostId }
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
  // Why: selectedRuns belong to the open automation; another one's manual run must not clear it.
  const runNowListed =
    runNowPending !== null &&
    runNowPending.rowKey === selectedRow?.key &&
    isAutomationRunNowListed(runNowPending, setup.selectedRuns)
  const isRunNowPending = isAutomationRunNowPending(
    runNowPending,
    selectedRow?.key,
    setup.selectedRuns
  )
  useEffect(() => {
    if (!runNowPending) {
      return
    }
    const { requestId } = runNowPending
    const clearThisRequest = (): void =>
      setRunNowPending((current) => settleAutomationRunNowPending(current, requestId, () => null))
    if (runNowListed) {
      clearThisRequest()
      return
    }
    // Why: a dispatch that never answers must not lock the button either; the dispatcher's
    // own in-flight guard still refuses a duplicate after this cap.
    const deadline =
      runNowPending.acknowledgedAt === null
        ? runNowPending.requestedAt + RUN_NOW_DISPATCH_MAX_MS
        : runNowPending.acknowledgedAt + RUN_NOW_PENDING_MAX_MS
    const timer = setTimeout(clearThisRequest, Math.max(0, deadline - Date.now()))
    return () => clearTimeout(timer)
  }, [runNowListed, runNowPending, setRunNowPending])

  const selectedHostId = automationRowHostId(selectedRow)
  const isResolving =
    Boolean(store.pendingAutomationRunNavigation) ||
    isLoading ||
    (local.selectedExternalKey !== null && list.scopedExternal.loading)
  const location: AutomationsPageLocation | null = isResolving
    ? null
    : runNotFound
      ? automationsPageNotFoundLocation(runNotFound)
      : pageView === 'runs'
        ? { page: 'runs' }
        : pageView === 'run'
          ? selected && selectedAutomationRunPage
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
            returnSelector: attributeSelector('data-automation-run-id', location.runId),
            returnRunId: location.runId
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
