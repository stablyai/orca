import { useAppStore } from '@/store'
import { checkRuntimeHooks } from '@/runtime/repo-hooks/runtime-hooks-client'
import { findWorktreeById } from '@/store/github/refresh/worktree-refresh'
import { selectWorktreesByRepo } from '@/store/workspaces/catalog/workspace-record-fields'
import type { AppState } from '@/store/types'
import type { OrcaHooks, OrcaRunAction } from '../../../../shared/orca-yaml-hook-types'
import {
  isRunActionAvailableOn,
  pickDefaultRunAction,
  type OrcaRunScripts
} from '../../../../shared/orca-yaml-run-actions'
import {
  getWorktreeExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import { listRunActionRuns } from './run-actions-store'

export type WorktreeRunActions = {
  actions: OrcaRunAction[]
  scripts: OrcaRunScripts
  /** Ids defined by the shared orca.yaml (they need the user's approval before running). */
  sharedIds: ReadonlySet<string>
}

export type RunActionTarget = {
  worktreeId: string
  worktreePath: string
  repoId: string
  hostId: ExecutionHostId
  isLocal: boolean
}

export function resolveRunActionTarget(
  state: AppState,
  worktreeId: string
): RunActionTarget | null {
  // The active-host hint can disagree for remote workspaces; fall back to the catalog row itself.
  const worktree =
    findWorktreeById(state, worktreeId) ??
    Object.values(selectWorktreesByRepo(state) ?? {})
      .flat()
      .find((candidate) => candidate.id === worktreeId)
  if (!worktree) {
    return null
  }
  const repo = state.repos.find((candidate) => candidate.id === worktree.repoId)
  const hostId = getWorktreeExecutionHostId(worktree, repo)
  return {
    worktreeId,
    worktreePath: worktree.path,
    repoId: worktree.repoId,
    hostId,
    isLocal: hostId === LOCAL_EXECUTION_HOST_ID
  }
}

/** orca.yaml actions plus this machine's own (an id defined locally replaces the shared one). */
export function mergeRunActions(
  shared: OrcaHooks['scripts'] | undefined,
  local: OrcaRunScripts | undefined,
  host: 'local' | 'remote'
): WorktreeRunActions {
  const byId = new Map<string, OrcaRunAction>()
  const sharedIds = new Set<string>()
  for (const action of shared?.run ?? []) {
    byId.set(action.id, action)
    sharedIds.add(action.id)
  }
  for (const action of local?.run ?? []) {
    byId.set(action.id, action)
    sharedIds.delete(action.id)
  }
  const actions = [...byId.values()].filter((action) => isRunActionAvailableOn(action, host))
  const runMode = local?.runMode ?? shared?.runMode
  const autoRunAfterSetup = local?.autoRunAfterSetup ?? shared?.autoRunAfterSetup
  return {
    actions,
    scripts: {
      run: actions,
      ...(runMode ? { runMode } : {}),
      ...(autoRunAfterSetup ? { autoRunAfterSetup } : {})
    },
    sharedIds
  }
}

export async function loadWorktreeRunActions(
  worktreeId: string,
  options: { background?: boolean } = {}
): Promise<WorktreeRunActions | null> {
  const state = useAppStore.getState()
  const target = resolveRunActionTarget(state, worktreeId)
  if (!target) {
    return null
  }
  const repo = state.repos.find((candidate) => candidate.id === target.repoId)
  let shared: OrcaHooks['scripts'] | undefined
  try {
    const result = await checkRuntimeHooks(target.hostId, target.repoId, options)
    shared = result.status === 'error' ? undefined : (result.hooks?.scripts ?? undefined)
  } catch {
    shared = undefined
  }
  return mergeRunActions(shared, repo?.hookSettings?.scripts, target.isLocal ? 'local' : 'remote')
}

/** The action the Run button and shortcut act on: the last one still running here, else the default. */
export function pickPrimaryRunAction(
  worktreeId: string,
  actions: readonly OrcaRunAction[]
): OrcaRunAction | null {
  // A one-shot action that already finished must not take the button from the dev server.
  const latestLive = listRunActionRuns()
    .filter(
      (run) =>
        run.worktreeId === worktreeId && (run.status === 'running' || run.status === 'stopping')
    )
    .sort((a, b) => b.startedAt - a.startedAt)[0]
  const liveAction = latestLive
    ? actions.find((action) => action.id === latestLive.actionId)
    : undefined
  return liveAction ?? pickDefaultRunAction(actions)
}

const RELAUNCH_RETRY_DELAYS_MS = [0, 3_000, 6_000, 12_000, 24_000, 48_000]
const RELAUNCH_ATTEMPT_TIMEOUT_MS = 10_000

/** A host that just restarted may not serve repo reads yet; give it a little while to answer. */
export async function loadRunActionsOnceHostAnswers(
  worktreeId: string
): Promise<WorktreeRunActions | null> {
  for (const delayMs of RELAUNCH_RETRY_DELAYS_MS) {
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
    // A read queued behind a reconnecting host can hang; bound each attempt and try again.
    const config = await Promise.race([
      loadWorktreeRunActions(worktreeId, { background: true }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), RELAUNCH_ATTEMPT_TIMEOUT_MS))
    ])
    if (config && config.actions.length > 0) {
      return config
    }
  }
  return null
}
