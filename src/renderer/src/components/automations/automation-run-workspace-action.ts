import type { AutomationRun } from '../../../../shared/automations-types'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { worktreeSelectionOwnerForRow } from '@/lib/worktree-selection-owner'
import { useAppStore } from '@/store'
import { getRepoCatalogOwnerHostId } from '../../store/projects/project-catalog-owner'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import {
  buildAutomationRunOpenLayout,
  getAutomationRunOpenTabId,
  resolveAutomationRunOpenTarget
} from './automation-run-open-target'
import { getAutomationRunViewState } from './automation-run-view-state'
import type { AutomationsPageActionContext } from './automations-page-action-context'

/** Opens the original run terminal when its host-qualified workspace is alive. */
export function createAutomationRunWorkspaceAction({
  store,
  list
}: {
  store: Pick<AutomationsPageActionContext['store'], 'repoForRow' | 'worktreeForRow'>
  list: Pick<AutomationsPageActionContext['list'], 'selectedRow'>
}) {
  const { repoForRow, worktreeForRow } = store
  const { selectedRow } = list
  return function openRunWorkspace(run: AutomationRun): void {
    const runRepo = selectedRow ? repoForRow(selectedRow) : undefined
    const runWorktree =
      run.workspaceId && selectedRow
        ? (worktreeForRow(selectedRow, runRepo, run.workspaceId) ?? null)
        : null
    const appStore = useAppStore.getState()
    const openTabId = getAutomationRunOpenTabId(run)
    const terminalTabExists = openTabId ? Boolean(appStore.getTab(openTabId)) : false
    const currentLayout = openTabId ? appStore.terminalLayoutsByTabId[openTabId] : null
    const livePtyIds = openTabId ? (appStore.ptyIdsByTabId[openTabId] ?? []) : []
    const terminalTarget = resolveAutomationRunOpenTarget({
      run,
      terminalTabExists,
      currentLayout,
      livePtyIds
    })
    const runViewState = getAutomationRunViewState({
      run,
      workspaceExists: Boolean(runWorktree),
      terminalTargetExists: terminalTarget !== null
    })
    if (!run.workspaceId || !runWorktree || !runViewState.canOpen) {
      toast.error(runViewState.statusLabel)
      return
    }
    if (runViewState.availability === 'terminal' && !terminalTarget) {
      toast.error(runViewState.statusLabel)
      return
    }
    const owner = runRepo ? worktreeSelectionOwnerForRow(runWorktree, [runRepo]) : null
    if (
      !owner ||
      !runRepo ||
      owner.publisherHostId !== getRepoCatalogOwnerHostId(runRepo) ||
      owner.executionHostId !==
        (runRepo.authoritativeExecutionHostId ?? getRepoExecutionHostId(runRepo)) ||
      appStore.getKnownWorktreeById(run.workspaceId, undefined, owner) !== runWorktree
    ) {
      toast.error(
        translate(
          'auto.components.automations.AutomationsPage.e1bf9b1512',
          'Workspace is not available.'
        )
      )
      return
    }
    if (terminalTarget && currentLayout) {
      if (activateAndRevealWorktree(run.workspaceId, { owner })) {
        appStore.setTabLayout(
          terminalTarget.tabId,
          buildAutomationRunOpenLayout({ target: terminalTarget, currentLayout })
        )
        appStore.setActiveTab(terminalTarget.tabId)
        appStore.setActiveTabType('terminal', run.workspaceId)
        return
      }
    }
    if (!activateAndRevealWorktree(run.workspaceId, { owner })) {
      toast.error(
        translate(
          'auto.components.automations.AutomationsPage.e1bf9b1512',
          'Workspace is not available.'
        )
      )
      return
    }
    toast.message(runViewState.statusLabel)
  }
}

export type AutomationRunWorkspaceAction = ReturnType<typeof createAutomationRunWorkspaceAction>
