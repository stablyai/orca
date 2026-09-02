import type { AutomationRun } from '../../../../shared/automations-types'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { useAppStore } from '@/store'
import {
  buildAutomationRunOpenLayout,
  getAutomationRunOpenTabId,
  resolveAutomationRunOpenTarget
} from './automation-run-open-target'
import { getAutomationRunViewState } from './automation-run-view-state'
import type { AutomationsPageActionContext } from './automations-page-action-context'

/** Opens the original run terminal when its host-qualified workspace is alive. */
export function createAutomationRunWorkspaceAction({ store, list }: AutomationsPageActionContext) {
  const { repoForRow, worktreeForRow } = store
  const { selectedRow } = list
  return function openRunWorkspace(run: AutomationRun): void {
    const runWorktree =
      run.workspaceId && selectedRow
        ? (worktreeForRow(selectedRow, repoForRow(selectedRow), run.workspaceId) ?? null)
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
    if (terminalTarget && currentLayout) {
      appStore.setTabLayout(
        terminalTarget.tabId,
        buildAutomationRunOpenLayout({ target: terminalTarget, currentLayout })
      )
      if (activateAndRevealWorktree(run.workspaceId)) {
        appStore.setActiveTab(terminalTarget.tabId)
        appStore.setActiveTabType('terminal')
        return
      }
    }
    if (!activateAndRevealWorktree(run.workspaceId)) {
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
