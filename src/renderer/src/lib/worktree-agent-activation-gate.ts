import { useAppStore } from '@/store'
import type { PtyListedSession } from '../../../shared/pty-listed-session'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import { worktreeIdsEqual } from '../../../shared/worktree/id'
import { listActivationPtySessionsForRoute } from './worktree-activation-pty-inventory'
import {
  resumeSleepingAgentSessionsForWorktree,
  type ResumeSleepingAgentSessionsOptions
} from './resume-sleeping-agent-session'
import {
  adoptLiveWorkspacePtySurfaces,
  bindLivePtyToExactSurface,
  type LiveSurfaceAdoptionStore
} from './worktree-agent-live-surface-adoption'
import type { LiveTerminalSurfaceOwnerIndex } from './worktree-live-terminal-surface-owners'
import { readWorktreeLiveTerminalSurfaceOwners } from './worktree-live-terminal-surface-owners'
import {
  readWorktreeStructuredActivationInventory,
  type StructuredActivationInventory
} from './worktree-agent-structured-inventory'
import {
  worktreeAgentActivationRouteKey,
  type WorktreeAgentActivationRoute
} from './worktree-agent-activation-route'
import { isActivationExecutionRouteCurrent } from './workspace-activation-recovery-state'
import {
  liveSleepingAgentClaimKeys,
  sessionBelongsToWorkspace,
  workspaceHasSleepingAgentSessions,
  workspaceHasStructuredAgentSession
} from './worktree-agent-activation-claims'

type ActivationStore = LiveSurfaceAdoptionStore &
  Pick<
    ReturnType<typeof useAppStore.getState>,
    'sleepingAgentSessionsByPaneKey' | 'unifiedTabsByWorktree'
  >

type ActivationGateDeps = {
  getState: () => ActivationStore
  awaitReady?: (operation?: ActivationGateOperation) => Promise<boolean>
  listSessions: (operation?: ActivationGateOperation) => Promise<PtyListedSession[]>
  /** Host-recorded PTY→surface ownership; null when the host could not answer. */
  listSurfaceOwners: (
    worktreeId: string,
    operation?: ActivationGateOperation
  ) => Promise<LiveTerminalSurfaceOwnerIndex | null>
  hasStructuredSession?: (
    worktreeId: string,
    operation?: ActivationGateOperation
  ) => Promise<boolean | StructuredActivationInventory>
  resume: (worktreeId: string, options?: ResumeSleepingAgentSessionsOptions) => number
  isRouteCurrent?: () => boolean
}

type ActivationGateOperation = { signal: AbortSignal; timeoutMs: number }

export type WorktreeAgentActivationOutcome =
  | 'adopted'
  | 'structured'
  | 'resumed'
  | 'empty'
  | 'blocked'
  | 'stale'

const inFlightByRoute = new Map<string, Promise<WorktreeAgentActivationOutcome>>()
const WORKSPACE_SESSION_READY_TIMEOUT_MS = 30_000

function waitForWorkspaceSessionReady(operation?: ActivationGateOperation): Promise<boolean> {
  const isReady = () => {
    const state = useAppStore.getState()
    return state.workspaceSessionReady && state.terminalStartupRestorationReady
  }
  if (isReady()) {
    return Promise.resolve(true)
  }
  return new Promise((resolve) => {
    let unsubscribe: (() => void) | null = null
    const settle = (ready: boolean) => {
      clearTimeout(timeout)
      unsubscribe?.()
      operation?.signal.removeEventListener('abort', onAbort)
      resolve(ready)
    }
    const onAbort = (): void => settle(false)
    const timeout = setTimeout(
      () => settle(isReady()),
      operation?.timeoutMs ?? WORKSPACE_SESSION_READY_TIMEOUT_MS
    )
    unsubscribe = useAppStore.subscribe((state) => {
      if (state.workspaceSessionReady && state.terminalStartupRestorationReady) {
        settle(true)
      }
    })
    operation?.signal.addEventListener('abort', onAbort, { once: true })
    if (operation?.signal.aborted) {
      settle(false)
      return
    }
    if (isReady()) {
      settle(true)
    }
  })
}

export async function runWorktreeAgentActivationGate(
  worktreeId: string,
  deps: ActivationGateDeps,
  route?: WorktreeAgentActivationRoute,
  operation?: ActivationGateOperation
): Promise<WorktreeAgentActivationOutcome> {
  const routeIsCurrent = (): boolean => deps.isRouteCurrent?.() !== false
  const mayAct = (): boolean => routeIsCurrent() && operation?.signal.aborted !== true
  const interruptedOutcome = (): WorktreeAgentActivationOutcome =>
    routeIsCurrent() ? 'blocked' : 'stale'
  if (!mayAct()) {
    return interruptedOutcome()
  }
  try {
    if (deps.awaitReady && !(await deps.awaitReady(operation))) {
      return interruptedOutcome()
    }
  } catch {
    return interruptedOutcome()
  }
  if (!mayAct()) {
    return interruptedOutcome()
  }
  let structured = false
  let structuredInventory: StructuredActivationInventory | null = null
  try {
    const reportedStructuredSession = await deps.hasStructuredSession?.(worktreeId, operation)
    structuredInventory =
      typeof reportedStructuredSession === 'object' ? reportedStructuredSession : null
    structured = Boolean(
      workspaceHasStructuredAgentSession(deps.getState(), worktreeId) || reportedStructuredSession
    )
  } catch {
    return interruptedOutcome()
  }
  if (!mayAct()) {
    return interruptedOutcome()
  }

  const structuredTabs = structuredInventory?.snapshot.tabs.filter(
    (tab) => tab.type === 'agent-session'
  )
  if (
    structuredTabs?.some((tab) => {
      const owner = structuredInventory?.ownerBySessionId.get(tab.sessionId)
      return (
        !owner ||
        (owner.owner === 'tui' &&
          (!owner.terminal || parsePaneKey(owner.terminal.paneKey)?.tabId !== owner.terminal.tabId))
      )
    })
  ) {
    return 'blocked'
  }
  if (
    structured &&
    !structuredInventory &&
    workspaceHasSleepingAgentSessions(deps.getState(), worktreeId)
  ) {
    return 'blocked'
  }

  let sessions: PtyListedSession[]
  try {
    sessions = await deps.listSessions(operation)
  } catch {
    // Inventory uncertainty cannot authorize a second writer.
    return interruptedOutcome()
  }
  if (!mayAct()) {
    return interruptedOutcome()
  }

  // Why either signal rather than a preference: a relay row's worktreeId can be seeded from the
  // host's own ORCA_WORKTREE_ID, so it must widen the id-prefix match, never replace it — a session
  // dropped from this set is a live agent the gate would fork a second writer onto.
  const liveWorkspaceSessions = sessions.filter(
    (session) =>
      (session.worktreeId !== undefined && worktreeIdsEqual(session.worktreeId, worktreeId)) ||
      sessionBelongsToWorkspace(session.id, worktreeId)
  )
  const liveWorkspacePtyIds = new Set(liveWorkspaceSessions.map((session) => session.id))
  for (const owner of structuredInventory?.ownerBySessionId.values() ?? []) {
    if (owner.owner !== 'tui') {
      continue
    }
    if (!mayAct()) {
      return interruptedOutcome()
    }
    if (
      !owner.terminal ||
      !liveWorkspacePtyIds.has(owner.terminal.ptyId) ||
      !bindLivePtyToExactSurface(deps.getState(), worktreeId, owner.terminal)
    ) {
      return 'blocked'
    }
  }
  let liveSurfaceAdopted = false
  if (liveWorkspaceSessions.length > 0) {
    // Why: an unreadable census adopts nothing and mints nothing, so reporting 'adopted' would
    // falsely settle the request; recovery presents the blocked result without starting a writer.
    const adoption = await adoptLiveWorkspacePtySurfaces(
      deps.getState,
      worktreeId,
      [...liveWorkspacePtyIds],
      (targetWorktreeId) => deps.listSurfaceOwners(targetWorktreeId, operation),
      mayAct
    )
    if (adoption.stale) {
      return interruptedOutcome()
    }
    liveSurfaceAdopted = adoption.surfaced
    // A live agent the user can no longer see has to be diagnosable from the console.
    if (adoption.declinedPtyIds.length > 0) {
      console.warn('[worktree-activation] live PTYs left without a surface', {
        worktreeId,
        declinedPtyIds: adoption.declinedPtyIds
      })
      if (!liveSurfaceAdopted) {
        return 'blocked'
      }
    }
    if (liveSurfaceAdopted && !workspaceHasSleepingAgentSessions(deps.getState(), worktreeId)) {
      return 'adopted'
    }
  }

  if (structured && !workspaceHasSleepingAgentSessions(deps.getState(), worktreeId)) {
    return 'structured'
  }
  if (!mayAct()) {
    return interruptedOutcome()
  }
  const launched = deps.resume(worktreeId, {
    skipClaimKeys: liveSleepingAgentClaimKeys(
      deps.getState(),
      worktreeId,
      liveWorkspacePtyIds,
      structuredInventory
    ),
    ...(route
      ? {
          expectedExecutionHostId: route.executionHostId,
          expectedRuntimeEnvironmentId: route.runtimeEnvironmentId,
          ...(route.runtimeEnvironmentRevision === null
            ? {}
            : { expectedRuntimeEnvironmentRevision: route.runtimeEnvironmentRevision })
        }
      : {})
  })
  // 'empty' is a caller directive, not a durable liveness verdict. The routed inventory above
  // must have completed before an SSH folder may use it as current host-absence evidence.
  return launched > 0
    ? 'resumed'
    : liveSurfaceAdopted
      ? 'adopted'
      : structured
        ? 'structured'
        : 'empty'
}

export function gateWorktreeAgentActivation(
  route: WorktreeAgentActivationRoute,
  options: { timeoutMs?: number } = {}
): Promise<WorktreeAgentActivationOutcome> {
  const key = worktreeAgentActivationRouteKey(route)
  const existing = inFlightByRoute.get(key)
  if (existing) {
    return existing
  }
  const controller = new AbortController()
  const timeoutMs = options.timeoutMs ?? WORKSPACE_SESSION_READY_TIMEOUT_MS
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  const operation = { signal: controller.signal, timeoutMs }
  const gate = runWorktreeAgentActivationGate(
    route.workspaceKey,
    {
      getState: () => useAppStore.getState(),
      awaitReady: waitForWorkspaceSessionReady,
      listSessions: (request) =>
        typeof window === 'undefined'
          ? Promise.resolve([])
          : listActivationPtySessionsForRoute(route, request),
      listSurfaceOwners: (_worktreeId, request) =>
        readWorktreeLiveTerminalSurfaceOwners(route, request),
      hasStructuredSession: (_worktreeId, request) =>
        readWorktreeStructuredActivationInventory(route, request),
      resume: resumeSleepingAgentSessionsForWorktree,
      isRouteCurrent: () => isActivationExecutionRouteCurrent(route)
    },
    route,
    operation
  ).finally(() => {
    clearTimeout(timeout)
    if (inFlightByRoute.get(key) === gate) {
      inFlightByRoute.delete(key)
    }
  })
  inFlightByRoute.set(key, gate)
  return gate
}

export function waitForWorktreeAgentActivationGateForTests(
  worktreeId: string
): Promise<WorktreeAgentActivationOutcome | null> {
  for (const [key, gate] of inFlightByRoute) {
    const routeKey: unknown = JSON.parse(key)
    if (Array.isArray(routeKey) && routeKey[3] === worktreeId) {
      return gate
    }
  }
  return Promise.resolve(null)
}
