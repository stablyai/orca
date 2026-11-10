import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { ensureHooksConfirmed } from '@/lib/ensure-hooks-confirmed'
import { sendRuntimePtyInput } from '@/runtime/hosted-terminals/input/runtime-terminal-input-send'
import { persistAgentLaunchTabOrder } from '@/lib/agent-session/launch/pane/launch-agent-tab-order'
import type { AppState } from '@/store/types'
import type { OrcaRunAction } from '../../../../shared/orca-yaml-hook-types'
import { effectiveRunMode, type OrcaRunScripts } from '../../../../shared/orca-yaml-run-actions'
import {
  deleteRunActionRun,
  getRunActionRun,
  listRunActionRuns,
  patchRunActionRun,
  setRunActionRun,
  type RunActionRun
} from './run-actions-store'
import {
  loadWorktreeRunActions,
  resolveRunActionTarget,
  type RunActionTarget,
  type WorktreeRunActions
} from './run-action-config'

/** Conductor's grace period: an interrupted dev server gets this long before its shell is closed. */
export const RUN_ACTION_STOP_GRACE_MS = 5_000
const INTERRUPT = '\x03'

function joinWorkspacePath(root: string, relative: string | undefined): string | undefined {
  if (!relative) {
    return undefined
  }
  const separator = root.includes('\\') && !root.includes('/') ? '\\' : '/'
  return `${root.replace(/[\\/]+$/, '')}${separator}${relative.split('/').join(separator)}`
}

export function tabExists(state: AppState, worktreeId: string, tabId: string): boolean {
  return (state.tabsByWorktree[worktreeId] ?? []).some((tab) => tab.id === tabId)
}

function tabGroupId(state: AppState, worktreeId: string, tabId: string): string | undefined {
  return (
    state.unifiedTabsByWorktree[worktreeId]?.find(
      (tab) => tab.entityId === tabId && tab.contentType === 'terminal'
    )?.groupId ?? undefined
  )
}

function closeRunTab(run: RunActionRun): void {
  const state = useAppStore.getState()
  if (tabExists(state, run.worktreeId, run.tabId)) {
    state.closeTab(run.tabId, { recordInteraction: false, captureRecentlyClosed: false })
  }
}

const stopWaiters = new Map<string, () => void>()

function waitForRunToStop(tabId: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      stopWaiters.delete(tabId)
      resolve(false)
    }, timeoutMs)
    stopWaiters.set(tabId, () => {
      clearTimeout(timer)
      stopWaiters.delete(tabId)
      resolve(true)
    })
  })
}

/**
 * Interrupt the action like Ctrl+C, so a dev server shuts down cleanly; if it is still running after
 * the grace period, close its terminal, which hangs up every process the shell started.
 */
export function stopRunAction(worktreeId: string, actionId: string): Promise<void> {
  const tabId = getRunActionRun(worktreeId, actionId)?.tabId
  const inFlight = tabId ? stopsInFlight.get(tabId) : undefined
  if (inFlight) {
    return inFlight
  }
  const stop = stopRunActionOnce(worktreeId, actionId).finally(() => {
    if (tabId) {
      stopsInFlight.delete(tabId)
    }
  })
  if (tabId) {
    stopsInFlight.set(tabId, stop)
  }
  return stop
}

const stopsInFlight = new Map<string, Promise<void>>()

async function stopRunActionOnce(worktreeId: string, actionId: string): Promise<void> {
  const run = getRunActionRun(worktreeId, actionId)
  if (!run || (run.status !== 'running' && run.status !== 'stopping')) {
    return
  }
  const state = useAppStore.getState()
  const ptyId = state.ptyIdsByTabId[run.tabId]?.[0]
  if (!ptyId || !tabExists(state, worktreeId, run.tabId)) {
    deleteRunActionRun(worktreeId, actionId)
    return
  }
  patchRunActionRun(worktreeId, actionId, { status: 'stopping' })
  sendRuntimePtyInput(ptyId, INTERRUPT, 'driving')
  const stopped = await waitForRunToStop(run.tabId, RUN_ACTION_STOP_GRACE_MS)
  if (!stopped) {
    closeRunTab(run)
    deleteRunActionRun(worktreeId, actionId)
  }
}

async function stopConflictingRuns(
  target: RunActionTarget,
  action: OrcaRunAction,
  scripts: OrcaRunScripts
): Promise<void> {
  if (effectiveRunMode(action, scripts) !== 'nonconcurrent') {
    return
  }
  // nonconcurrent: the project shares one port/database/stack, so any other live action must stop first.
  const conflicting = listRunActionRuns().filter(
    (run) =>
      run.repoId === target.repoId &&
      (run.status === 'running' || run.status === 'stopping') &&
      !(run.worktreeId === target.worktreeId && run.actionId === action.id)
  )
  await Promise.all(conflicting.map((run) => stopRunAction(run.worktreeId, run.actionId)))
}

export type StartRunActionOptions = {
  /** Focus the run's terminal; background starts (auto-run, host restart) leave focus alone. */
  activate?: boolean
  /** Where the run's terminal goes when it has no earlier terminal to replace. */
  groupId?: string
  /** The earlier run's processes are already gone (its host restarted): skip the interrupt. */
  previousProcessGone?: boolean
}

const startsInFlight = new Map<string, Promise<boolean>>()

/**
 * Start an action, or restart it if it is already running. Returns false if it did not start.
 * Starts of one action in one workspace run one at a time, so a double press never orphans a run.
 */
export function startRunAction(
  worktreeId: string,
  action: OrcaRunAction,
  config: WorktreeRunActions,
  options: StartRunActionOptions = {}
): Promise<boolean> {
  const key = `${worktreeId}\n${action.id}`
  const previous = startsInFlight.get(key) ?? Promise.resolve(true)
  const next = previous
    .catch(() => false)
    .then(() => startRunActionNow(worktreeId, action, config, options))
    .finally(() => {
      if (startsInFlight.get(key) === next) {
        startsInFlight.delete(key)
      }
    })
  startsInFlight.set(key, next)
  return next
}

/** The action to execute after approval: re-read, so what runs is exactly what was approved. */
async function approvedAction(
  target: RunActionTarget,
  action: OrcaRunAction,
  config: WorktreeRunActions
): Promise<{ action: OrcaRunAction; config: WorktreeRunActions } | null> {
  if (!config.sharedIds.has(action.id)) {
    return { action, config }
  }
  const decision = await ensureHooksConfirmed(
    () => useAppStore.getState(),
    target.repoId,
    'run',
    target.hostId
  )
  if (decision !== 'run') {
    return null
  }
  const fresh = await loadWorktreeRunActions(target.worktreeId)
  const freshAction = fresh?.actions.find((candidate) => candidate.id === action.id)
  if (!fresh || !freshAction || !fresh.sharedIds.has(action.id)) {
    return null
  }
  return { action: freshAction, config: fresh }
}

async function startRunActionNow(
  worktreeId: string,
  requested: OrcaRunAction,
  requestedConfig: WorktreeRunActions,
  options: StartRunActionOptions
): Promise<boolean> {
  const target = resolveRunActionTarget(useAppStore.getState(), worktreeId)
  if (!target) {
    return false
  }
  const approved = await approvedAction(target, requested, requestedConfig)
  if (!approved) {
    return false
  }
  const { action, config } = approved
  await stopConflictingRuns(target, action, config.scripts)

  const previous = getRunActionRun(worktreeId, action.id)
  let groupId = options.groupId
  if (previous) {
    if (!options.previousProcessGone) {
      await stopRunAction(worktreeId, action.id)
    }
    groupId = tabGroupId(useAppStore.getState(), worktreeId, previous.tabId) ?? groupId
    closeRunTab(previous)
    if (getRunActionRun(worktreeId, action.id)?.tabId === previous.tabId) {
      deleteRunActionRun(worktreeId, action.id)
    }
  }

  const activate = options.activate !== false
  const store = useAppStore.getState()
  const tab = store.createTab(worktreeId, groupId, undefined, {
    recordInteraction: activate,
    activate,
    pendingStartup: {
      command: action.command,
      ...(action.env ? { env: action.env } : {})
    },
    ...(action.cwd ? { startupCwd: joinWorkspacePath(target.worktreePath, action.cwd) } : {})
  })
  store.setTabCustomTitle(
    tab.id,
    translate('runActions.tabTitle', 'Run: {{name}}', { name: action.name }),
    { recordInteraction: false }
  )
  if (activate) {
    store.setActiveTabType('terminal', worktreeId)
  }
  persistAgentLaunchTabOrder(worktreeId, tab.id)
  setRunActionRun({
    worktreeId,
    repoId: target.repoId,
    actionId: action.id,
    actionName: action.name,
    tabId: tab.id,
    status: 'running',
    exitCode: null,
    startedAt: Date.now()
  })
  return true
}

/** Runs remembered while a workspace's host restarts; its tab list may be rebuilt meanwhile. */
const pendingRelaunches = new Map<string, RunActionRun[]>()

/**
 * The workspace's host is about to restart (its shells will be new). Remember what is running
 * now, so tab-list churn during the restart cannot make Orca forget it.
 */
export function armRunActionRelaunch(worktreeId: string): void {
  const running = listRunActionRuns().filter(
    (run) => run.worktreeId === worktreeId && run.status === 'running'
  )
  const armed = pendingRelaunches.get(worktreeId) ?? []
  const byAction = new Map([...armed, ...running].map((run) => [run.actionId, run]))
  pendingRelaunches.set(worktreeId, [...byAction.values()])
}

export function isRunActionRelaunchArmed(worktreeId: string): boolean {
  return pendingRelaunches.has(worktreeId)
}

export function disarmRunActionRelaunch(worktreeId: string): void {
  pendingRelaunches.delete(worktreeId)
}

/**
 * The workspace's host restarted: its shells are new, so every action that was running starts
 * again in a fresh terminal, without stealing focus.
 */
export async function relaunchInterruptedRunActions(worktreeId: string): Promise<number> {
  const byAction = new Map<string, RunActionRun>()
  for (const run of pendingRelaunches.get(worktreeId) ?? []) {
    byAction.set(run.actionId, run)
  }
  pendingRelaunches.delete(worktreeId)
  for (const run of listRunActionRuns()) {
    if (run.worktreeId === worktreeId && run.status === 'running') {
      byAction.set(run.actionId, run)
    }
  }
  if (byAction.size === 0) {
    return 0
  }
  const config = await loadWorktreeRunActions(worktreeId)
  let started = 0
  for (const run of byAction.values()) {
    const action = config?.actions.find((candidate) => candidate.id === run.actionId)
    if (!action || !config) {
      continue
    }
    const groupId = tabGroupId(useAppStore.getState(), worktreeId, run.tabId)
    // Re-record the run if pruning dropped it, so the start replaces its old terminal.
    if (!getRunActionRun(worktreeId, run.actionId)) {
      setRunActionRun(run)
    }
    const ok = await startRunAction(worktreeId, action, config, {
      activate: false,
      previousProcessGone: true,
      ...(groupId ? { groupId } : {})
    })
    if (ok) {
      started += 1
    }
  }
  return started
}

/** A run's terminal reported its command finished; wake whoever is waiting for it to stop. */
export function notifyRunActionStopped(tabId: string): void {
  stopWaiters.get(tabId)?.()
}
