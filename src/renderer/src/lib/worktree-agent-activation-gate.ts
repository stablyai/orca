import { useAppStore } from '@/store'
import type { PtyListedSession } from '../../../shared/pty-listed-session'
import { parsePtySessionId, PTY_SESSION_ID_SEPARATOR } from '../../../shared/pty-session-id-format'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { worktreeIdsEqual } from '../../../shared/worktree/id'
import { listActivationPtySessions } from './worktree-activation-pty-inventory'
import {
  resumeSleepingAgentSessionsForWorktree,
  type ResumeSleepingAgentSessionsOptions
} from './resume-sleeping-agent-session'
import { getProviderSessionClaimKey } from './sleeping-agent-pane-ownership'
import {
  adoptLiveWorkspacePtySurfaces,
  type LiveSurfaceAdoptionStore
} from './worktree-agent-live-surface-adoption'
import type { LiveTerminalSurfaceOwnerIndex } from './worktree-live-terminal-surface-owners'
import { readWorktreeLiveTerminalSurfaceOwners } from './worktree-live-terminal-surface-owners'
import { isStructuredAgentSyntheticSleepingRecord } from './structured-agent-synthetic-sleeping-record'
import {
  readWorktreeStructuredActivationInventory,
  type StructuredActivationInventory
} from './worktree-agent-structured-inventory'

type ActivationStore = LiveSurfaceAdoptionStore &
  Pick<
    ReturnType<typeof useAppStore.getState>,
    'sleepingAgentSessionsByPaneKey' | 'unifiedTabsByWorktree'
  >

type ActivationGateDeps = {
  getState: () => ActivationStore
  awaitReady?: () => Promise<boolean>
  listSessions: () => Promise<PtyListedSession[]>
  /** Host-recorded PTY→surface ownership; null when the host could not answer. */
  listSurfaceOwners: (worktreeId: string) => Promise<LiveTerminalSurfaceOwnerIndex | null>
  hasStructuredSession?: (worktreeId: string) => Promise<boolean | StructuredActivationInventory>
  resume: (worktreeId: string, options?: ResumeSleepingAgentSessionsOptions) => number
}

export type WorktreeAgentActivationOutcome =
  | 'adopted'
  | 'structured'
  | 'resumed'
  | 'empty'
  | 'unsurfaced'
  | 'blocked'

/** Both ask the caller to seed (STA-5701): no surface came out of the gate. Only `empty` means the
 *  host listed no live PTY here; `unsurfaced` PTYs may belong to tabs a pending sync still carries. */
export function activationOutcomeNeedsSeed(outcome: WorktreeAgentActivationOutcome): boolean {
  return outcome === 'empty' || outcome === 'unsurfaced'
}

const inFlightByWorktreeId = new Map<string, Promise<WorktreeAgentActivationOutcome>>()
const WORKSPACE_SESSION_READY_TIMEOUT_MS = 30_000

function waitForWorkspaceSessionReady(): Promise<boolean> {
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
      resolve(ready)
    }
    const timeout = setTimeout(() => settle(isReady()), WORKSPACE_SESSION_READY_TIMEOUT_MS)
    unsubscribe = useAppStore.subscribe((state) => {
      if (state.workspaceSessionReady && state.terminalStartupRestorationReady) {
        settle(true)
      }
    })
    if (isReady()) {
      settle(true)
    }
  })
}

export function workspaceHasSleepingAgentSessions(
  state: Pick<ReturnType<typeof useAppStore.getState>, 'sleepingAgentSessionsByPaneKey'>,
  worktreeId: string
): boolean {
  return Object.values(state.sleepingAgentSessionsByPaneKey).some(
    (record) => record.worktreeId === worktreeId
  )
}

function hasStructuredSession(store: ActivationStore, worktreeId: string): boolean {
  return (store.unifiedTabsByWorktree[worktreeId] ?? []).some(
    (tab) => tab.contentType === 'agent-session'
  )
}

function sessionBelongsToWorkspace(sessionId: string, worktreeId: string): boolean {
  if (parsePtySessionId(sessionId).worktreeId === worktreeId) {
    return true
  }
  const scope = parseWorkspaceKey(worktreeId)
  return (
    scope?.type === 'folder' &&
    sessionId.startsWith(`${worktreeId}${PTY_SESSION_ID_SEPARATOR}`) &&
    sessionId.length > worktreeId.length + PTY_SESSION_ID_SEPARATOR.length
  )
}

function liveSleepingAgentClaims(
  store: ActivationStore,
  worktreeId: string,
  livePtyIds: ReadonlySet<string>,
  structuredInventory: StructuredActivationInventory | null
): { keys: Set<string>; claimedPtyIds: Set<string> } {
  const keys = new Set<string>()
  const claimedPtyIds = new Set<string>()
  for (const record of Object.values(store.sleepingAgentSessionsByPaneKey)) {
    if (record.worktreeId !== worktreeId) {
      continue
    }
    const stable = parsePaneKey(record.paneKey)
    const tabId = record.tabId ?? stable?.tabId
    const layoutPtyId = stable
      ? store.terminalLayoutsByTabId[stable.tabId]?.ptyIdsByLeafId?.[stable.leafId]
      : undefined
    const tabPtyIds = tabId ? store.ptyIdsByTabId[tabId] : undefined
    const structuredOwner =
      stable && isStructuredAgentSyntheticSleepingRecord(record)
        ? structuredInventory?.ownerBySessionId.get(record.providerSession.id)
        : undefined
    if (structuredOwner?.owner === 'native') {
      keys.add(getProviderSessionClaimKey(record))
      continue
    }
    const persistedPtyId = layoutPtyId ?? (tabPtyIds?.length === 1 ? tabPtyIds[0] : undefined)
    if (persistedPtyId && livePtyIds.has(persistedPtyId)) {
      claimedPtyIds.add(persistedPtyId)
      keys.add(getProviderSessionClaimKey(record))
    }
  }
  return { keys, claimedPtyIds }
}

export async function runWorktreeAgentActivationGate(
  worktreeId: string,
  deps: ActivationGateDeps
): Promise<WorktreeAgentActivationOutcome> {
  try {
    if (deps.awaitReady && !(await deps.awaitReady())) {
      return 'blocked'
    }
  } catch {
    return 'blocked'
  }
  let structured = false
  let structuredInventory: StructuredActivationInventory | null = null
  try {
    const reportedStructuredSession = await deps.hasStructuredSession?.(worktreeId)
    structuredInventory =
      typeof reportedStructuredSession === 'object' ? reportedStructuredSession : null
    structured = Boolean(
      hasStructuredSession(deps.getState(), worktreeId) || reportedStructuredSession
    )
  } catch {
    return 'blocked'
  }

  const structuredTabs = structuredInventory?.snapshot.tabs.filter(
    (tab) => tab.type === 'agent-session'
  )
  if (structuredTabs?.some((tab) => !structuredInventory?.ownerBySessionId.has(tab.sessionId))) {
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
    sessions = await deps.listSessions()
  } catch {
    // Inventory uncertainty cannot authorize a second writer.
    return 'blocked'
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
  let liveSurfaceAdopted = false
  if (liveWorkspaceSessions.length > 0) {
    // Why: an unreadable census adopts nothing and mints nothing, so reporting 'adopted'
    // would suppress the caller's seed and leave the workspace with no surface at all —
    // fail-closed must still leave the user a usable pane (STA-5701).
    const adoption = await adoptLiveWorkspacePtySurfaces(
      deps.getState,
      worktreeId,
      [...liveWorkspacePtyIds],
      deps.listSurfaceOwners
    )
    liveSurfaceAdopted = adoption.surfaced
    // A live agent the user can no longer see has to be diagnosable from the console.
    if (adoption.declinedPtyIds.length > 0) {
      console.warn('[worktree-activation] live PTYs left without a surface', {
        worktreeId,
        declinedPtyIds: adoption.declinedPtyIds
      })
    }
    if (liveSurfaceAdopted && !workspaceHasSleepingAgentSessions(deps.getState(), worktreeId)) {
      return 'adopted'
    }
  }

  if (structured && !workspaceHasSleepingAgentSessions(deps.getState(), worktreeId)) {
    return 'structured'
  }
  const store = deps.getState()
  const claims = liveSleepingAgentClaims(
    store,
    worktreeId,
    liveWorkspacePtyIds,
    structuredInventory
  )
  const hasUnclaimedRecovery = Object.values(store.sleepingAgentSessionsByPaneKey).some(
    (record) =>
      record.worktreeId === worktreeId && !claims.keys.has(getProviderSessionClaimKey(record))
  )
  // A surfaced PTY without a conversation claim may still own the sleeping session.
  if (
    hasUnclaimedRecovery &&
    liveWorkspaceSessions.some(
      (session) => session.agentOwnership !== 'absent' && !claims.claimedPtyIds.has(session.id)
    )
  ) {
    return 'blocked'
  }
  const launched = deps.resume(worktreeId, { skipClaimKeys: claims.keys })
  return launched > 0
    ? 'resumed'
    : liveSurfaceAdopted
      ? 'adopted'
      : structured
        ? 'structured'
        : liveWorkspaceSessions.length > 0
          ? 'unsurfaced'
          : 'empty'
}

export function gateWorktreeAgentActivation(
  worktreeId: string
): Promise<WorktreeAgentActivationOutcome> {
  const existing = inFlightByWorktreeId.get(worktreeId)
  if (existing) {
    return existing
  }
  const gate = runWorktreeAgentActivationGate(worktreeId, {
    getState: () => useAppStore.getState(),
    awaitReady: waitForWorkspaceSessionReady,
    listSessions: () =>
      typeof window === 'undefined'
        ? Promise.resolve([])
        : listActivationPtySessions(useAppStore.getState(), worktreeId),
    listSurfaceOwners: readWorktreeLiveTerminalSurfaceOwners,
    hasStructuredSession: readWorktreeStructuredActivationInventory,
    resume: resumeSleepingAgentSessionsForWorktree
  }).finally(() => {
    if (inFlightByWorktreeId.get(worktreeId) === gate) {
      inFlightByWorktreeId.delete(worktreeId)
    }
  })
  inFlightByWorktreeId.set(worktreeId, gate)
  return gate
}

export function waitForWorktreeAgentActivationGateForTests(
  worktreeId: string
): Promise<WorktreeAgentActivationOutcome | null> {
  return inFlightByWorktreeId.get(worktreeId) ?? Promise.resolve(null)
}
