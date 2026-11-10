import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import {
  ORCA_TERMINAL_COMMAND_FINISHED_EVENT,
  type TerminalCommandFinishedEventDetail
} from '@/hooks/terminal-command-finished-event'
import type { AppState } from '@/store/types'
import { pickAutoRunAction } from '../../../../shared/orca-yaml-run-actions'
import {
  deleteRunActionRun,
  findRunActionRunByTab,
  getRunActionRun,
  listRunActionRuns,
  patchRunActionRun
} from './run-actions-store'
import { loadWorktreeRunActions, pickPrimaryRunAction } from './run-action-config'
import {
  isRunActionRelaunchArmed,
  notifyRunActionStopped,
  startRunAction
} from './run-action-controller'

const autoRunSetupTabs = new Map<string, string>()

/** After this setup terminal's command succeeds, start the action `autoRunAfterSetup` names. */
export function armAutoRunAfterSetup(worktreeId: string, setupTabId: string): void {
  autoRunSetupTabs.set(setupTabId, worktreeId)
}

async function autoRunAfterSetup(worktreeId: string): Promise<void> {
  const config = await loadWorktreeRunActions(worktreeId)
  const action = config ? pickAutoRunAction(config.scripts) : null
  if (config && action && !getRunActionRun(worktreeId, action.id)) {
    await startRunAction(worktreeId, action, config, { activate: false })
  }
}

function isCommandFinishedDetail(value: unknown): value is TerminalCommandFinishedEventDetail {
  return typeof value === 'object' && value !== null && 'worktreeId' in value
}

function handleCommandFinished(detail: TerminalCommandFinishedEventDetail): void {
  const { tabId, exitCode } = detail
  if (!tabId) {
    return
  }
  const setupWorktreeId = autoRunSetupTabs.get(tabId)
  if (setupWorktreeId) {
    autoRunSetupTabs.delete(tabId)
    if (exitCode === 0) {
      void autoRunAfterSetup(setupWorktreeId)
    }
  }
  const run = findRunActionRunByTab(tabId)
  if (!run || (run.status !== 'running' && run.status !== 'stopping')) {
    return
  }
  // OSC 133;D may omit the exit code; without one the run is only known to have ended.
  const status =
    run.status === 'stopping'
      ? 'stopped'
      : exitCode === 0 || exitCode === null
        ? 'exited'
        : 'failed'
  patchRunActionRun(run.worktreeId, run.actionId, { status, exitCode })
  notifyRunActionStopped(tabId)
}

function pruneClosedRunTabs(state: AppState): void {
  for (const run of listRunActionRuns()) {
    // A restarting host rebuilds its tab list; the relaunch owns these runs until it settles.
    if (isRunActionRelaunchArmed(run.worktreeId)) {
      continue
    }
    const tabs = state.tabsByWorktree[run.worktreeId]
    // Unhydrated workspaces have no tab list yet; only a loaded list proves the tab is gone.
    if (tabs && !tabs.some((tab) => tab.id === run.tabId)) {
      deleteRunActionRun(run.worktreeId, run.actionId)
      notifyRunActionStopped(run.tabId)
    }
  }
  for (const [tabId, worktreeId] of autoRunSetupTabs) {
    const tabs = state.tabsByWorktree[worktreeId]
    if (tabs && !tabs.some((tab) => tab.id === tabId)) {
      autoRunSetupTabs.delete(tabId)
    }
  }
}

/** Follows run terminals: their exits update status, and closing one forgets its run. */
export function installRunActionEvents(): () => void {
  const onFinished = (event: Event): void => {
    if (event instanceof CustomEvent && isCommandFinishedDetail(event.detail)) {
      handleCommandFinished(event.detail)
    }
  }
  window.addEventListener(ORCA_TERMINAL_COMMAND_FINISHED_EVENT, onFinished)
  const unsubscribe = useAppStore.subscribe((state, previous) => {
    if (state.tabsByWorktree !== previous.tabsByWorktree) {
      pruneClosedRunTabs(state)
    }
  })
  return () => {
    window.removeEventListener(ORCA_TERMINAL_COMMAND_FINISHED_EVENT, onFinished)
    unsubscribe()
  }
}

/** The shortcut: start the primary action, or restart it when it is already running. */
export async function runOrRestartPrimaryRunAction(worktreeId: string): Promise<void> {
  const config = await loadWorktreeRunActions(worktreeId)
  const action = config ? pickPrimaryRunAction(worktreeId, config.actions) : null
  if (!config || !action) {
    toast.info(translate('runActions.noneTitle', 'No run actions for this workspace'), {
      description: translate(
        'runActions.noneBody',
        'Add a command under scripts.run in orca.yaml, for example a dev server on $ORCA_PORT.'
      )
    })
    return
  }
  await startRunAction(worktreeId, action, config)
}
