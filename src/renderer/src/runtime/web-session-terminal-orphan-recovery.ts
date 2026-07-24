import type {
  RuntimeMobileSessionTabsResult,
  RuntimeTerminalListResult,
  RuntimeTerminalOrphanAdoptionResult
} from '../../../shared/runtime-types'
import type { TerminalTab } from '../../../shared/types'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import { parseRemoteRuntimePtyId } from './runtime-terminal-stream'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'
import { isWebTerminalSurfaceTabId, toHostSessionTabId } from './web-terminal-surface-id'
import {
  buildWebTerminalOrphanTopologyProposal,
  type WebTerminalOrphanTopologyState
} from './web-session-terminal-orphan-topology'

type TerminalOrphanRecoveryState = WebTerminalOrphanTopologyState & {
  tabsByWorktree: Record<string, TerminalTab[]>
}

type RuntimeCall = (args: {
  selector: string
  method: string
  params: unknown
  timeoutMs: number
}) => Promise<RuntimeRpcResponse<unknown>>

const inFlightRecoveryByWorktree = new Map<string, Promise<RuntimeMobileSessionTabsResult | null>>()

function recoveryKey(environmentId: string, worktreeId: string): string {
  return `${environmentId}\0${worktreeId}`
}

function isTerminalListResult(value: unknown): value is RuntimeTerminalListResult {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    Array.isArray((value as { terminals?: unknown }).terminals)
  )
}

function isAdoptionResult(value: unknown): value is RuntimeTerminalOrphanAdoptionResult {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    Boolean((value as { snapshot?: unknown }).snapshot) &&
    Array.isArray((value as { snapshot?: { tabs?: unknown } }).snapshot?.tabs)
  )
}

async function recoverTerminalOrphans(
  state: TerminalOrphanRecoveryState,
  snapshot: RuntimeMobileSessionTabsResult,
  environmentId: string,
  call: RuntimeCall
): Promise<RuntimeMobileSessionTabsResult | null> {
  const hostSurfaceKeys = new Set(
    snapshot.tabs
      .filter((tab) => tab.type === 'terminal')
      .map((tab) => `${tab.parentTabId}\0${tab.leafId}`)
  )
  const candidates = (state.tabsByWorktree[snapshot.worktree] ?? []).filter(
    (tab) =>
      isWebTerminalSurfaceTabId(tab.id) &&
      Object.keys(state.terminalLayoutsByTabId[tab.id]?.ptyIdsByLeafId ?? {}).some(
        (leafId) => !hostSurfaceKeys.has(`${toHostSessionTabId(tab.id)}\0${leafId}`)
      )
  )
  if (candidates.length === 0) {
    return snapshot
  }
  const candidateSurfaces = candidates.flatMap((tab) => {
    const layout = state.terminalLayoutsByTabId[tab.id]
    return Object.entries(layout?.ptyIdsByLeafId ?? {}).flatMap(([leafId, remotePtyId]) => {
      const remote = parseRemoteRuntimePtyId(remotePtyId)
      return remote?.environmentId === environmentId &&
        !hostSurfaceKeys.has(`${toHostSessionTabId(tab.id)}\0${leafId}`)
        ? [{ tabId: toHostSessionTabId(tab.id), leafId, handle: remote.handle }]
        : []
    })
  })
  const candidateHandles = new Set(candidateSurfaces.map((surface) => surface.handle))
  if (candidateHandles.size === 0) {
    return snapshot
  }
  if (candidateHandles.size > 64) {
    return null
  }
  const listedResponse = await call({
    selector: environmentId,
    method: 'terminal.list',
    params: {
      worktree: toRuntimeWorktreeSelector(snapshot.worktree),
      handles: [...candidateHandles],
      requireFreshPtyLiveness: true
    },
    timeoutMs: 15_000
  })
  if (listedResponse.ok === false || !isTerminalListResult(listedResponse.result)) {
    return null
  }
  const listed = listedResponse.result
  const orphanByHandle = new Map(
    listed.terminals
      .filter(
        (terminal) =>
          terminal.orphaned === true &&
          typeof terminal.ptyId === 'string' &&
          typeof terminal.incarnationId === 'string'
      )
      .map((terminal) => [terminal.handle, terminal])
  )
  const claims = candidateSurfaces.flatMap(({ tabId, leafId, handle }) => {
    const orphan = orphanByHandle.get(handle)
    if (!orphan?.ptyId || !orphan.incarnationId) {
      return []
    }
    return [
      {
        terminal: orphan.handle,
        ptyId: orphan.ptyId,
        incarnationId: orphan.incarnationId,
        tabId,
        leafId
      }
    ]
  })
  const claimedHandles = new Set(claims.map((claim) => claim.terminal))
  const listedCandidateHandles = new Set(
    listed.terminals
      .filter((terminal) => candidateHandles.has(terminal.handle))
      .map((terminal) => terminal.handle)
  )
  if (
    listed.truncated &&
    [...candidateHandles].some((handle) => !listedCandidateHandles.has(handle))
  ) {
    return null
  }
  const hasUnresolvedLiveCandidate = listed.terminals.some(
    (terminal) => candidateHandles.has(terminal.handle) && !claimedHandles.has(terminal.handle)
  )
  if (hasUnresolvedLiveCandidate) {
    return null
  }
  if (claims.length === 0) {
    return snapshot
  }
  const localActiveTabId = state.activeTabIdByWorktree[snapshot.worktree]
  const activeTabId =
    localActiveTabId && isWebTerminalSurfaceTabId(localActiveTabId)
      ? toHostSessionTabId(localActiveTabId)
      : undefined
  const activeGroupId = state.activeGroupIdByWorktree[snapshot.worktree] ?? undefined
  const topology = buildWebTerminalOrphanTopologyProposal(
    state,
    snapshot.worktree,
    candidates,
    claims
  )
  const response = await call({
    selector: environmentId,
    method: 'terminal.adoptOrphans',
    params: {
      worktree: toRuntimeWorktreeSelector(snapshot.worktree),
      expectedTopologyRevision: listed.topologyRevisions?.[snapshot.worktree] ?? 0,
      claims,
      ...(activeTabId ? { activeTabId } : {}),
      ...(activeGroupId ? { activeGroupId } : {}),
      ...(topology ? { topology } : {})
    },
    timeoutMs: 15_000
  })
  return response.ok !== false &&
    isAdoptionResult(response.result) &&
    response.result.snapshot.worktree === snapshot.worktree
    ? response.result.snapshot
    : null
}

export function recoverWebSessionTerminalOrphansBeforeApply(
  state: TerminalOrphanRecoveryState,
  snapshot: RuntimeMobileSessionTabsResult,
  environmentId: string,
  call: RuntimeCall = (args) => window.api.runtimeEnvironments.call(args)
): Promise<RuntimeMobileSessionTabsResult | null> {
  const key = recoveryKey(environmentId, snapshot.worktree)
  const existing = inFlightRecoveryByWorktree.get(key)
  const recovery = (existing ?? Promise.resolve(null))
    .catch(() => null)
    .then(() => recoverTerminalOrphans(state, snapshot, environmentId, call))
    .catch(() => null)
    .finally(() => {
      if (inFlightRecoveryByWorktree.get(key) === recovery) {
        inFlightRecoveryByWorktree.delete(key)
      }
    })
  inFlightRecoveryByWorktree.set(key, recovery)
  return recovery
}

export function clearWebSessionTerminalOrphanRecoveryForTests(): void {
  inFlightRecoveryByWorktree.clear()
}
