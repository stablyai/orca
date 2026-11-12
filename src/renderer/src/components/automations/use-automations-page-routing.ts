import { useEffect } from 'react'
import type { AutomationRunNotFound, AutomationsPageLocation } from './automation-page-state'
import { automationRowHostId } from './automations-page-navigation'
import { automationRunFocusKey } from './runs/automations-reveal-run'
import {
  isAutomationRunNowListed,
  automationRunNowPendingDeadline,
  isAutomationRunNowPending,
  settleAutomationRunNowPending
} from './runs/automation-run-now-pending'
import type { AutomationsPageController } from './use-automations-page-controller'
import {
  useAutomationsPageFocus,
  useAutomationsPageHistory,
  type AutomationsPageFocusTarget
} from './use-automations-page-history'

// JSON string quoting is valid CSS string quoting for the ids and keys used here.
function attributeSelector(name: string, value: string): string {
  return `[${name}=${JSON.stringify(value)}]`
}

/**
 * The run's row on the page you return to. The global Runs table can list one run id under two
 * hosts, so its rows match only by the host-qualified key; rail and history rows (one
 * automation on one host) match by id.
 */
export function automationsRunReturnSelector(runId: string, rowKey: string | undefined): string {
  const byId = attributeSelector('data-automation-run-id', runId)
  return rowKey
    ? `${attributeSelector('data-automation-run-key', automationRunFocusKey(rowKey, runId))}, ${byId}:not([data-automation-run-key])`
    : byId
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
  // Each automation keeps its own request, so starting another one never frees this one.
  const selectedPending = selectedRow ? (runNowPending[selectedRow.key] ?? null) : null
  const runNowListed =
    selectedPending !== null && isAutomationRunNowListed(selectedPending, setup.selectedRuns)
  const isRunNowPending = isAutomationRunNowPending(
    selectedPending,
    selectedRow?.key,
    setup.selectedRuns
  )
  useEffect(() => {
    if (!selectedPending) {
      return
    }
    const { rowKey, requestId } = selectedPending
    const clearThisRequest = (): void =>
      setRunNowPending((byRow) =>
        settleAutomationRunNowPending(byRow, rowKey, requestId, () => null)
      )
    if (runNowListed) {
      clearThisRequest()
      return
    }
    // Why: a dispatch that never answers must not lock the button forever.
    const deadline = automationRunNowPendingDeadline(selectedPending)
    const timer = setTimeout(clearThisRequest, Math.max(0, deadline - Date.now()))
    return () => clearTimeout(timer)
  }, [runNowListed, selectedPending, setRunNowPending])

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
            returnSelector: automationsRunReturnSelector(location.runId, selectedRow?.key),
            returnRunId: location.runId,
            returnRunKey: selectedRow
              ? automationRunFocusKey(selectedRow.key, location.runId)
              : undefined
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
