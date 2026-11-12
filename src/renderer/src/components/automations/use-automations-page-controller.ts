import { useMemo } from 'react'
import { createAutomationManagementActions } from './authoring/automation-management-actions'
import { createAutomationRunActions } from './runs/automation-run-actions'
import { createAutomationRunWorkspaceAction } from './runs/automation-run-workspace-action'
import { createAutomationSaveAction } from './authoring/automation-save-action'
import { useAutomationDraftEffects } from './authoring/use-automation-draft-effects'
import { useAutomationEditorActions } from './authoring/use-automation-editor-actions'
import { useAutomationMigrateAction } from './authoring/use-automation-migrate-action'
import { useAutomationRunPageState } from './runs/use-automation-run-page-state'
import { useAutomationsPageEscape } from './use-automations-page-escape'
import { useAutomationsPageListState } from './listing/use-automations-page-list-state'
import { useAutomationsPageLocalState } from './use-automations-page-local-state'
import { useAutomationsPageDestinationState } from './authoring/use-automations-page-destination-state'
import { useAutomationsPageDestinationForm } from './authoring/use-automations-page-destination-form'
import { useAutomationsPagePresentationState } from './use-automations-page-presentation-state'
import { useAutomationsPageRefresh } from './use-automations-page-refresh'
import { useAutomationsPageSetupState } from './authoring/use-automations-page-setup-state'
import { useAutomationsPageStoreState } from './use-automations-page-store-state'
import { useExternalAutomationActions } from './external/use-external-automation-actions'
import { useAutomationRunsDashboard } from './runs/use-automation-runs-dashboard'
import { createAutomationsPageNavigation } from './automations-page-navigation'

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
  const setup = useAutomationsPageSetupState({
    store,
    local,
    list,
    draftRepos: destinationForm.dialogRepos
  })
  const runPage = useAutomationRunPageState({ store, local, list, setup })
  const presentation = useAutomationsPagePresentationState({
    store,
    local,
    list,
    destination,
    destinationForm
  })
  const pageRefresh = useAutomationsPageRefresh({
    store,
    local,
    list,
    destination
  })
  const draftEffects = useAutomationDraftEffects({
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
  const saveContext = { store, local, list, setup, destination, destinationForm, pageRefresh }
  const saveAutomation = createAutomationSaveAction(saveContext)
  const migrateAction = useAutomationMigrateAction(saveContext, editorActions)
  const actionContext = {
    store,
    local,
    list,
    setup,
    destination,
    destinationForm,
    presentation,
    pageRefresh
  }
  const managementActions = createAutomationManagementActions(actionContext)
  const runActions = createAutomationRunActions(actionContext)
  const externalActions = useExternalAutomationActions(actionContext)
  const openRunWorkspace = createAutomationRunWorkspaceAction(actionContext)
  const { setPendingAutomationRunNavigation } = store
  const {
    setPageView,
    setIsDetailOpen,
    setActivePaneTab,
    setSelectedAutomationRunPageId,
    setRunPageOrigin,
    setRunNotFound,
    selectExternalKey
  } = local
  const { selectAutomationRow } = list
  const navigation = useMemo(
    () =>
      createAutomationsPageNavigation({
        store: { setPendingAutomationRunNavigation },
        local: {
          setPageView,
          setIsDetailOpen,
          setActivePaneTab,
          setSelectedAutomationRunPageId,
          setRunPageOrigin,
          setRunNotFound,
          selectExternalKey
        },
        selectAutomationRow
      }),
    [
      selectAutomationRow,
      selectExternalKey,
      setActivePaneTab,
      setIsDetailOpen,
      setPageView,
      setPendingAutomationRunNavigation,
      setRunNotFound,
      setRunPageOrigin,
      setSelectedAutomationRunPageId
    ]
  )
  useAutomationsPageEscape({ store, local, navigation })

  return {
    store,
    local,
    list,
    destination,
    runsDashboard,
    destinationForm,
    setup,
    runPage,
    presentation,
    pageRefresh,
    draftEffects,
    editorActions,
    saveAutomation,
    migrateAction,
    managementActions,
    runActions,
    externalActions,
    openRunWorkspace,
    navigation
  }
}

export type AutomationsPageController = ReturnType<typeof useAutomationsPageController>
