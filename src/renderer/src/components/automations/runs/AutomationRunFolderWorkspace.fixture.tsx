import { useAppStore } from '@/store/index'
import { workspaceCatalogConfirmsAbsence } from '@/store/workspaces/catalog/workspace-catalog-absence'
import { folderWorkspaceKey } from '../../../../../shared/workspace/identity/workspace-scope'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import { makeAutomation, makeRun } from '../automations-page-fixtures'
import { AutomationRunDetailsPage } from './AutomationRunDetailsPage'
import { getAutomationRunViewState } from './automation-run-view-state'
import { getAutomationRunDetailsWorkspaceName } from './automation-run-workspace-display'

const timestamp = Date.UTC(2026, 10, 20, 19)
const automation = makeAutomation({ name: 'Nightly triage', agentId: 'codex' })
const workspaceId = folderWorkspaceKey('sample-folder')
const run = makeRun({
  runNumber: 12,
  scheduledFor: timestamp,
  startedAt: timestamp,
  dispatchedAt: timestamp,
  createdAt: timestamp,
  workspaceId,
  workspaceDisplayName: 'Sample research folder'
})
const runs = [run]
const history = {
  automationId: automation.id,
  rowKey: null,
  ownerKey: null,
  authority: null,
  navigation: null,
  reloadToken: 0,
  runs,
  notice: null
}
const noop = (): void => {}

function FolderWorkspaceRunFixture(): React.JSX.Element {
  const workspaceRemoved = useAppStore((state) =>
    workspaceCatalogConfirmsAbsence(state, workspaceId, 'local')
  )
  const viewState = getAutomationRunViewState({
    run,
    workspaceExists: false,
    terminalTargetExists: false
  })
  const actionLabel = viewState.canOpen ? viewState.actionLabel : null
  return (
    <AutomationRunDetailsPage
      nav={null}
      automation={automation}
      run={run}
      runs={runs}
      history={history}
      relativeNow={timestamp}
      hostLabel="This Mac"
      workspaceName={getAutomationRunDetailsWorkspaceName({
        run,
        worktree: null,
        actionLabel,
        workspaceRemoved
      })}
      workspaceActionLabel={actionLabel}
      canRerun={false}
      isRerunPending={false}
      onRerun={noop}
      onOpenWorkspace={noop}
      onReviewSetup={noop}
      onSelectRun={noop}
    />
  )
}

const folderFixture = {
  width: 400,
  store: { startupWorktreeRefreshCompleted: true },
  render: () => <FolderWorkspaceRunFixture />
}

export const catalogLoading = defineFixture(folderFixture)

export const catalogConfirmsRemoval = defineFixture({
  ...folderFixture,
  setup: () => {
    window.api.folderWorkspaces.list = async () => []
  },
  interact: () =>
    useAppStore.getState().fetchFolderWorkspaces({ runtimeEnvironmentId: null, throwOnError: true })
})
