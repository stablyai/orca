import { toRuntimeExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import type { AutomationRun } from '../../../../shared/automations/history/automation-run'
import type { AutomationListRow } from './listing/automation-list-row-identity'
import type { AutomationRunPageOrigin, AutomationsPageLocation } from './automation-page-state'
import type { AutomationsPageLocalState } from './use-automations-page-local-state'
import type { AutomationsPageStoreState } from './use-automations-page-store-state'

/** The host a row was listed from, in the id space deep links and history use. */
export function automationRowHostId(
  row: Pick<AutomationListRow, 'catalogRef'> | null | undefined
): ExecutionHostId | undefined {
  const authority = row?.catalogRef?.authority
  return authority?.kind === 'runtime'
    ? toRuntimeExecutionHostId(authority.environmentId)
    : undefined
}

type NavigationLocal = Pick<
  AutomationsPageLocalState,
  | 'setPageView'
  | 'setIsDetailOpen'
  | 'setActivePaneTab'
  | 'setSelectedAutomationRunPageId'
  | 'setRunPageOrigin'
  | 'setRunNotFound'
  | 'selectExternalKey'
  | 'setListSearchQuery'
>

/** Every page change goes through here, so the crumbs, Escape and Back agree on the state. */
export function createAutomationsPageNavigation({
  store,
  local,
  selectAutomationRow,
  showAllHosts
}: {
  store: Pick<AutomationsPageStoreState, 'setPendingAutomationRunNavigation'>
  local: NavigationLocal
  selectAutomationRow: (rowKey: string | null) => void
  showAllHosts: () => void
}) {
  const {
    setPageView,
    setIsDetailOpen,
    setActivePaneTab,
    setSelectedAutomationRunPageId,
    setRunPageOrigin,
    setRunNotFound,
    selectExternalKey,
    setListSearchQuery
  } = local
  const leaveRun = (): void => {
    store.setPendingAutomationRunNavigation(null)
    setSelectedAutomationRunPageId(null)
    setRunNotFound(null)
  }
  const showList = (): void => {
    leaveRun()
    setPageView('automations')
    setIsDetailOpen(false)
    setActivePaneTab('overview')
  }
  const showRuns = (): void => {
    leaveRun()
    setPageView('runs')
    setIsDetailOpen(false)
    setActivePaneTab('overview')
  }
  /** The selected automation's detail, or its run history page. */
  const showSelectedAutomation = (paneTab: 'overview' | 'runs' = 'overview'): void => {
    leaveRun()
    setPageView('automations')
    setIsDetailOpen(true)
    setActivePaneTab(paneTab)
  }
  const openSelectedAutomationRun = (run: AutomationRun, origin: AutomationRunPageOrigin): void => {
    store.setPendingAutomationRunNavigation(null)
    setRunNotFound(null)
    setSelectedAutomationRunPageId(run.id)
    setRunPageOrigin(origin)
    setPageView('run')
  }
  /** Escape from a run page undoes the step that opened it. */
  const returnFromRun = (origin: AutomationRunPageOrigin): void => {
    if (origin === 'runs') {
      showRuns()
      return
    }
    showSelectedAutomation(origin === 'automationRuns' ? 'runs' : 'overview')
  }
  /** Apply a back/forward history entry. Automation pages resolve through the deep-link path. */
  const goToLocation = (location: AutomationsPageLocation): void => {
    // Why: the list keeps its search; an automation is resolved among all rows, not the filtered ones.
    if (location.page !== 'list' && location.page !== 'runs') {
      setListSearchQuery('')
    }
    switch (location.page) {
      case 'list':
        showList()
        return
      case 'runs':
        showAllHosts()
        showRuns()
        return
      case 'external':
        leaveRun()
        selectAutomationRow(null)
        selectExternalKey(location.externalKey)
        setPageView('automations')
        setIsDetailOpen(true)
        setActivePaneTab('overview')
        return
      case 'detail':
      case 'automationRuns':
        setRunNotFound(null)
        store.setPendingAutomationRunNavigation({
          automationId: location.automationId,
          runId: null,
          hostId: location.hostId,
          paneTab: location.page === 'automationRuns' ? 'runs' : 'overview'
        })
        return
      case 'run':
        setRunNotFound(null)
        store.setPendingAutomationRunNavigation({
          automationId: location.automationId,
          runId: location.runId,
          hostId: location.hostId,
          origin: location.origin
        })
    }
  }
  return {
    showList,
    showRuns,
    showSelectedAutomation,
    openSelectedAutomationRun,
    returnFromRun,
    goToLocation
  }
}

export type AutomationsPageNavigation = ReturnType<typeof createAutomationsPageNavigation>
