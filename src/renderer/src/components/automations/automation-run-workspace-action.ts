import type { AutomationRun } from '../../../../shared/automations-types'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { useAppStore } from '@/store'
import { activateTerminalTabOnOwner } from '@/lib/terminal-tab-owner-activation'
import { activateWebRuntimeSessionTab } from '@/runtime/web-runtime-session'
import { resolveWebSessionVisibleTabId } from '@/runtime/web-session-focus-intent'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import {
  buildAutomationRunOpenLayout,
  getAutomationRunOwnerEnvironmentId,
  resolveAutomationRunTerminalTarget
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
    const ownerEnvironmentId = runWorktree
      ? getAutomationRunOwnerEnvironmentId(appStore, run.workspaceId, runWorktree.hostId)
      : null
    const terminalTarget = resolveAutomationRunTerminalTarget(
      run,
      {
        hasTerminalTab: (tabId) => Boolean(appStore.getTab(tabId)),
        terminalLayoutsByTabId: appStore.terminalLayoutsByTabId,
        ptyIdsByTabId: appStore.ptyIdsByTabId
      },
      ownerEnvironmentId
    )
    const currentLayout = terminalTarget
      ? appStore.terminalLayoutsByTabId[terminalTarget.tabId]
      : null
    const runViewState = getAutomationRunViewState({
      run,
      workspaceExists: Boolean(runWorktree),
      terminalTargetExists: terminalTarget !== null,
      terminalOnPairedServer: ownerEnvironmentId !== null
    })
    if (!run.workspaceId || !runWorktree || !runViewState.canOpen) {
      toast.error(runViewState.statusLabel)
      return
    }
    const paneRef = parsePaneKey(run.terminalPaneKey ?? '')
    if (runViewState.availability === 'terminal' && !terminalTarget) {
      if (!ownerEnvironmentId || !paneRef) {
        toast.error(runViewState.statusLabel)
        return
      }
      if (!activateAndRevealWorktree(run.workspaceId)) {
        toast.error(workspaceUnavailableMessage())
        return
      }
      // Why: the mirror may not hold the pane yet; the server focuses it when it arrives.
      void openRunTerminalOnOwner(run.workspaceId, ownerEnvironmentId, paneRef)
      return
    }
    if (terminalTarget && currentLayout) {
      appStore.setTabLayout(
        terminalTarget.tabId,
        buildAutomationRunOpenLayout({ target: terminalTarget, currentLayout })
      )
      if (activateAndRevealWorktree(run.workspaceId)) {
        appStore.setActiveTab(terminalTarget.tabId)
        appStore.setActiveTabType('terminal', run.workspaceId)
        activateTerminalTabOnOwner(run.workspaceId, terminalTarget.tabId, terminalTarget.leafId)
        return
      }
    }
    if (!activateAndRevealWorktree(run.workspaceId)) {
      toast.error(workspaceUnavailableMessage())
      return
    }
    toast.message(runViewState.statusLabel)
  }
}

function workspaceUnavailableMessage(): string {
  return translate(
    'auto.components.automations.AutomationsPage.e1bf9b1512',
    'Workspace is not available.'
  )
}

async function openRunTerminalOnOwner(
  worktreeId: string,
  environmentId: string,
  paneRef: { tabId: string; leafId: string }
): Promise<void> {
  const opened = await activateWebRuntimeSessionTab({
    worktreeId,
    tabId: paneRef.tabId,
    environmentId,
    leafId: paneRef.leafId,
    expectedCurrentLocalTabId: resolveWebSessionVisibleTabId(useAppStore.getState(), worktreeId)
  })
  if (!opened) {
    toast.error(
      translate('components.automations.runTerminalUnavailable', 'Run terminal is unavailable.')
    )
  }
}

export type AutomationRunWorkspaceAction = ReturnType<typeof createAutomationRunWorkspaceAction>
