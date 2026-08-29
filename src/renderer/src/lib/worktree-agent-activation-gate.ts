import { useAppStore } from '@/store'
import type { PtyListedSession } from '../../../shared/pty-listed-session'
import { parsePtySessionId, PTY_SESSION_ID_SEPARATOR } from '../../../shared/pty-session-id-format'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import {
  resumeSleepingAgentSessionsForWorktree,
  type ResumeSleepingAgentSessionsOptions
} from './resume-sleeping-agent-session'
import { getProviderSessionClaimKey } from './sleeping-agent-pane-ownership'
import { bindLivePtyToExactSurface } from './worktree-agent-live-surface-adoption'
import { isStructuredAgentSyntheticSleepingRecord } from './structured-agent-synthetic-sleeping-record'
import {
  readWorktreeStructuredActivationInventory,
  type StructuredActivationInventory
} from './worktree-agent-structured-inventory'

type ActivationStore = Pick<
  ReturnType<typeof useAppStore.getState>,
  | 'createTab'
  | 'ptyIdsByTabId'
  | 'sleepingAgentSessionsByPaneKey'
  | 'tabsByWorktree'
  | 'terminalLayoutsByTabId'
  | 'unifiedTabsByWorktree'
  | 'updateTabPtyId'
  | 'replaceTerminalLayoutPanePtyId'
>

type ActivationGateDeps = {
  getState: () => ActivationStore
  awaitReady?: () => Promise<boolean>
  listSessions: () => Promise<PtyListedSession[]>
  hasStructuredSession?: (worktreeId: string) => Promise<boolean | StructuredActivationInventory>
  resume: (worktreeId: string, options?: ResumeSleepingAgentSessionsOptions) => number
}

export type WorktreeAgentActivationOutcome =
  | 'adopted'
  | 'structured'
  | 'resumed'
  | 'empty'
  | 'blocked'

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

function ptyIsAlreadyBound(store: ActivationStore, ptyId: string): boolean {
  return Object.values(store.ptyIdsByTabId).some((ids) => ids.includes(ptyId))
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

function liveSleepingAgentClaimKeys(
  store: ActivationStore,
  worktreeId: string,
  livePtyIds: ReadonlySet<string>,
  structuredInventory: StructuredActivationInventory | null
): Set<string> {
  const keys = new Set<string>()
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
    // Packaged hydration can omit renderer bindings while main retains this session's exact TUI.
    const structuredOwnerPtyId =
      structuredOwner?.owner === 'tui' ? structuredOwner.terminal?.ptyId : undefined
    const persistedPtyId =
      layoutPtyId ?? (tabPtyIds?.length === 1 ? tabPtyIds[0] : undefined) ?? structuredOwnerPtyId
    if (persistedPtyId && livePtyIds.has(persistedPtyId)) {
      keys.add(getProviderSessionClaimKey(record))
    }
  }
  return keys
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
    sessions = await deps.listSessions()
  } catch {
    // Inventory uncertainty cannot authorize a second writer.
    return 'blocked'
  }

  const liveWorkspaceSessions = sessions.filter((session) =>
    sessionBelongsToWorkspace(session.id, worktreeId)
  )
  const liveWorkspacePtyIds = new Set(liveWorkspaceSessions.map((session) => session.id))
  for (const owner of structuredInventory?.ownerBySessionId.values() ?? []) {
    if (owner.owner !== 'tui') {
      continue
    }
    if (
      !owner.terminal ||
      !liveWorkspacePtyIds.has(owner.terminal.ptyId) ||
      !bindLivePtyToExactSurface(deps.getState(), worktreeId, owner.terminal)
    ) {
      return 'blocked'
    }
  }
  if (liveWorkspaceSessions.length > 0) {
    for (const session of liveWorkspaceSessions) {
      const store = deps.getState()
      if (ptyIsAlreadyBound(store, session.id)) {
        continue
      }
      store.createTab(worktreeId, undefined, undefined, {
        initialPtyId: session.id,
        activate: false,
        recordInteraction: false
      })
    }
    if (!workspaceHasSleepingAgentSessions(deps.getState(), worktreeId)) {
      return 'adopted'
    }
  }

  if (structured && !workspaceHasSleepingAgentSessions(deps.getState(), worktreeId)) {
    return 'structured'
  }
  const launched = deps.resume(worktreeId, {
    skipClaimKeys: liveSleepingAgentClaimKeys(
      deps.getState(),
      worktreeId,
      liveWorkspacePtyIds,
      structuredInventory
    )
  })
  return launched > 0
    ? 'resumed'
    : liveWorkspaceSessions.length > 0
      ? 'adopted'
      : structured
        ? 'structured'
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
      typeof window === 'undefined' ? Promise.resolve([]) : window.api.pty.listSessions(),
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
