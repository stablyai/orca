import { createAutomationManagementActions } from './automation-management-actions'
import { createAutomationRunActions } from './automation-run-actions'
import { createAutomationRunWorkspaceAction } from './automation-run-workspace-action'
import { createAutomationSaveAction } from './automation-save-action'
import { useAutomationDraftEffects } from './use-automation-draft-effects'
import { useAutomationEditorActions } from './use-automation-editor-actions'
import { useAutomationRunPageState } from './use-automation-run-page-state'
import { useAutomationSourceAvailability } from './use-automation-source-availability'
import { useAutomationsPageEscape } from './use-automations-page-escape'
import { useAutomationsPageListState } from './use-automations-page-list-state'
import { useAutomationsPageLocalState } from './use-automations-page-local-state'
import { useAutomationsPageDestinationState } from './use-automations-page-destination-state'
import { useAutomationsPageDestinationForm } from './use-automations-page-destination-form'
import { useAutomationsPagePresentationState } from './use-automations-page-presentation-state'
import { useAutomationsPageRefresh } from './use-automations-page-refresh'
import { useAutomationsPageSetupState } from './use-automations-page-setup-state'
import { useAutomationsPageStoreState } from './use-automations-page-store-state'
import { useExternalAutomationActions } from './use-external-automation-actions'
import { useAutomationRunsDashboard } from './use-automation-runs-dashboard'

export function useAutomationsPageController() {
  const store = useAutomationsPageStoreState()
  const local = useAutomationsPageLocalState(store)
  const list = useAutomationsPageListState({ store, local })
  const destination = useAutomationsPageDestinationState({ store, local, list })
  const runsDashboard = useAutomationRunsDashboard({
    enabled: local.pageView === 'runs',
    rows: list.visibleRows,
    context: destination.automationDispatchContext,
    legacyTarget: destination.automationHostTargetFor,
    authorityForRow: destination.automationAuthorityForRow,
    reloadToken: local.runHistoryReloadToken
  })
  const destinationForm = useAutomationsPageDestinationForm({
    store,
    local,
    list,
    base: destination
  })
  const setup = useAutomationsPageSetupState({ store, local, list })
  const runPage = useAutomationRunPageState({ store, local, list, setup })
  const sourceAvailability = useAutomationSourceAvailability(list.visibleRows)
  const presentation = useAutomationsPagePresentationState({
    store,
    local,
    list,
    destination,
    destinationForm,
    sourceAvailability
  })
  const pageRefresh = useAutomationsPageRefresh({
    store,
    local,
    list,
    destination
  })
  const draftEffects = useAutomationDraftEffects({
    store,
    local,
    setup,
    destination,
    destinationForm,
    pageRefresh
  })
  const editorActions = useAutomationEditorActions({
    store,
    local,
    destination,
    destinationForm
  })
  const saveAutomation = createAutomationSaveAction({
    store,
    local,
    list,
    setup,
    destination,
    destinationForm,
    pageRefresh
  })
  const actionContext = {
    store,
    local,
    list,
    setup,
    destination,
    destinationForm,
    sourceAvailability,
    presentation,
    pageRefresh
  }
  const managementActions = createAutomationManagementActions(actionContext)
  const runActions = createAutomationRunActions(actionContext)
  const externalActions = useExternalAutomationActions(actionContext)
  const openRunWorkspace = createAutomationRunWorkspaceAction(actionContext)
  useAutomationsPageEscape({ store, local })

  return {
    store,
    local,
    list,
    destination,
    runsDashboard,
    destinationForm,
    setup,
    runPage,
    sourceAvailability,
    presentation,
    pageRefresh,
    draftEffects,
    editorActions,
    saveAutomation,
    managementActions,
    runActions,
    externalActions,
    openRunWorkspace
  }
}

export type AutomationsPageController = ReturnType<typeof useAutomationsPageController>
