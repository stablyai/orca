import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import {
  ORCA_TERMINAL_COMMAND_FINISHED_EVENT,
  type TerminalCommandFinishedEventDetail
} from '@/lib/terminal/output/terminal-command-finished-event'
import type { AppState } from '@/store/types'
import { getRemoteRuntimePtyOwner } from '@/runtime/hosted-terminals/identity/remote-runtime-pty-owner'
import { pickAutoRunAction } from '../../../../shared/orca-yaml-run-actions'
import {
  deleteRunActionRun,
  findRunActionRunByTab,
  getRunActionRun,
  listRunActionRuns,
  patchRunActionRun,
  type RunActionRun
} from './run-actions-store'
import {
  loadWorktreeRunActions,
  pickPrimaryRunAction,
  type WorktreeRunActions
} from './run-action-config'
import { findLiveRunTabId, runPanePtyId, runTabLeafIds, sameRunTab } from './run-action-tabs'
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
  const setupTabId = [...autoRunSetupTabs.keys()].find((armed) => sameRunTab(armed, tabId))
  const setupWorktreeId = setupTabId ? autoRunSetupTabs.get(setupTabId) : undefined
  if (setupTabId && setupWorktreeId) {
    autoRunSetupTabs.delete(setupTabId)
    if (exitCode === 0) {
      void autoRunAfterSetup(setupWorktreeId)
    }
  }
  const run = findRunActionRunByTab(tabId)
  if (!run || (run.status !== 'running' && run.status !== 'stopping')) {
    return
  }
  if (!isRunPane(run, detail.leafId)) {
    // A command finished in a split of the run's tab, not the action itself.
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

function isRunPane(run: RunActionRun, leafId: string | undefined): boolean {
  if (!leafId) {
    return true
  }
  if (run.leafId) {
    return run.leafId === leafId
  }
  // The run's pane isn't known yet: only a tab with one pane proves which pane finished.
  const leaves = runTabLeafIds(useAppStore.getState(), run.worktreeId, run.tabId)
  return leaves.length <= 1
}

/** A run learns its pane while its tab still has exactly one, before any split exists. */
function learnRunPanes(state: AppState): void {
  for (const run of listRunActionRuns()) {
    if (run.leafId) {
      continue
    }
    const leaves = runTabLeafIds(state, run.worktreeId, run.tabId)
    if (leaves.length === 1) {
      patchRunActionRun(run.worktreeId, run.actionId, { leafId: leaves[0] })
    }
  }
}

function pruneClosedRunTabs(state: AppState): void {
  for (const run of listRunActionRuns()) {
    // A restarting host rebuilds its tab list; the relaunch owns these runs until it settles.
    if (isRunActionRelaunchArmed(run.worktreeId)) {
      continue
    }
    const tabs = state.tabsByWorktree[run.worktreeId]
    // Unhydrated workspaces have no tab list yet; only a loaded list proves the tab is gone.
    if (tabs && !findLiveRunTabId(state, run.worktreeId, run.tabId)) {
      deleteRunActionRun(run.worktreeId, run.actionId)
      notifyRunActionStopped(run.tabId)
    }
  }
  for (const [tabId, worktreeId] of autoRunSetupTabs) {
    const tabs = state.tabsByWorktree[worktreeId]
    if (tabs && !findLiveRunTabId(state, worktreeId, tabId)) {
      autoRunSetupTabs.delete(tabId)
    }
  }
}

const AUTO_RAN_KEY = 'orca.runActions.autoRan.v1'

function readAutoRan(): string[] {
  try {
    const parsed: unknown = JSON.parse(globalThis.localStorage?.getItem(AUTO_RAN_KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

/**
 * The host ran setup while building the environment, so no Setup tab will ever finish here:
 * honor `autoRunAfterSetup` the first time the workspace is opened, once per workspace.
 */
export async function autoRunProvisionedWorkspaceOnce(
  worktreeId: string,
  config: WorktreeRunActions
): Promise<boolean> {
  const action = config.setupProvisioned ? pickAutoRunAction(config.scripts) : null
  const autoRan = readAutoRan()
  if (!action || autoRan.includes(worktreeId) || getRunActionRun(worktreeId, action.id)) {
    return false
  }
  try {
    // Recorded before starting, so a second open (or window) can't start it twice.
    globalThis.localStorage?.setItem(
      AUTO_RAN_KEY,
      JSON.stringify([...autoRan, worktreeId].slice(-500))
    )
  } catch {
    // Best effort: without storage this still runs once per window session.
  }
  return startRunAction(worktreeId, action, config, { activate: false })
}

/** Follows run terminals: their exits update status, and closing one forgets its run. */
export function installRunActionEvents(): () => void {
  const onFinished = (event: Event): void => {
    if (event instanceof CustomEvent && isCommandFinishedDetail(event.detail)) {
      handleCommandFinished(event.detail)
    }
  }
  window.addEventListener(ORCA_TERMINAL_COMMAND_FINISHED_EVENT, onFinished)
  // Tab lists churn while a window hydrates or a host republishes its tabs: only a tab still
  // missing after things settle was really closed.
  let pruneTimer: ReturnType<typeof setTimeout> | null = null
  const installedAt = Date.now()
  const unsubscribe = useAppStore.subscribe((state, previous) => {
    if (state.terminalLayoutsByTabId !== previous.terminalLayoutsByTabId) {
      learnRunPanes(state)
    }
    if (state.tabsByWorktree === previous.tabsByWorktree || pruneTimer) {
      return
    }
    const delay = Math.max(PRUNE_SETTLE_MS, installedAt + STARTUP_PRUNE_GRACE_MS - Date.now())
    pruneTimer = setTimeout(() => {
      pruneTimer = null
      pruneClosedRunTabs(useAppStore.getState())
    }, delay)
  })
  // After a restart, a run recorded as running may have ended while nobody watched its terminal.
  const reconcileTimer = setTimeout(
    () => void reconcileLocalRunsAfterStartup(),
    STARTUP_RECONCILE_MS
  )
  return () => {
    window.removeEventListener(ORCA_TERMINAL_COMMAND_FINISHED_EVENT, onFinished)
    unsubscribe()
    clearTimeout(reconcileTimer)
    if (pruneTimer) {
      clearTimeout(pruneTimer)
    }
  }
}

const STARTUP_RECONCILE_MS = 5_000
const PRUNE_SETTLE_MS = 3_000
const STARTUP_PRUNE_GRACE_MS = 15_000

/** Local terminals can say whether anything still runs under the shell; remote ones are left as recorded. */
async function reconcileLocalRunsAfterStartup(): Promise<void> {
  const state = useAppStore.getState()
  for (const run of listRunActionRuns()) {
    const ptyId = runPanePtyId(state, run.worktreeId, run.tabId, run.leafId)
    if (run.status !== 'running' || !ptyId || getRemoteRuntimePtyOwner(ptyId)) {
      continue
    }
    const probe = window.api?.pty?.hasChildProcesses
    const busy = probe ? await probe(ptyId).catch(() => true) : true
    if (!busy) {
      patchRunActionRun(run.worktreeId, run.actionId, { status: 'exited', exitCode: null })
    }
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
