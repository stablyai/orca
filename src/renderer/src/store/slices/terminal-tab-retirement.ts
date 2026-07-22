import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import type { AppState } from '../types'
import {
  getExecutionHostIdForWorktree,
  getRuntimeEnvironmentIdForWorktree,
  type WorktreeRuntimeOwnerState
} from '@/lib/worktree-runtime-owner'
import { parseRemoteRuntimePtyId } from '@/runtime/runtime-terminal-stream'
import { resolveWorktreeOperationRouteResult } from '@/lib/worktree-operation-route'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'

export type TerminalTabCloseReason = 'user' | 'cleanup' | 'pty-exit'

export type TerminalTabRetirementState = WorktreeRuntimeOwnerState &
  Pick<
    AppState,
    | 'tabsByWorktree'
    | 'unifiedTabsByWorktree'
    | 'ptyIdsByTabId'
    | 'terminalLayoutsByTabId'
    | 'lastKnownRelayPtyIdByTabId'
    | 'deferredSshSessionIdsByTabId'
    | 'pendingReconnectPtyIdByTabId'
  >

export type TerminalTabRetirementPlan = {
  tabId: string
  worktreeId: string | null
  ptyIds: string[]
  localOrSshPtyIds: string[]
  runtimeTerminals: {
    ptyId: string
    environmentId: string | null
    handle: string
  }[]
  cleanupOnlyPtyIds: string[]
  sharedPtyIds: string[]
  unroutablePtyIds: string[]
}

function appendPtyId(ids: Set<string>, ptyId: string | null | undefined): void {
  if (ptyId) {
    ids.add(ptyId)
  }
}

export function getTerminalPtyOwnershipIdentity(
  state: TerminalTabRetirementState,
  ptyId: string,
  worktreeId: string | null
): string {
  const remote = parseRemoteRuntimePtyId(ptyId)
  if (!remote?.handle) {
    return `pty:${ptyId}`
  }
  // Why: hydrated legacy runtime IDs omit their owner, but still refer to the
  // same provider terminal as a scoped ID in the owning worktree.
  const environmentId =
    remote.environmentId?.trim() || getRuntimeEnvironmentIdForWorktree(state, worktreeId) || ''
  return JSON.stringify(['runtime', environmentId, remote.handle])
}

function collectPtyIdsForTab(
  state: TerminalTabRetirementState,
  tabId: string,
  rowPtyId: string | null | undefined
): string[] {
  const ids = new Set<string>()
  for (const ptyId of state.ptyIdsByTabId[tabId] ?? []) {
    appendPtyId(ids, ptyId)
  }
  appendPtyId(ids, rowPtyId)
  for (const ptyId of Object.values(state.terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId ?? {})) {
    appendPtyId(ids, ptyId)
  }
  appendPtyId(ids, state.lastKnownRelayPtyIdByTabId[tabId])
  appendPtyId(ids, state.deferredSshSessionIdsByTabId[tabId])
  appendPtyId(ids, state.pendingReconnectPtyIdByTabId[tabId])
  return [...ids]
}

function collectLiveTerminalTabs(
  state: TerminalTabRetirementState
): Map<string, { worktreeId: string; rowPtyId: string | null }> {
  const liveTabs = new Map<string, { worktreeId: string; rowPtyId: string | null }>()
  for (const [worktreeId, tabs] of Object.entries(state.tabsByWorktree)) {
    for (const tab of tabs) {
      liveTabs.set(tab.id, { worktreeId, rowPtyId: tab.ptyId })
    }
  }
  for (const [worktreeId, tabs] of Object.entries(state.unifiedTabsByWorktree)) {
    for (const tab of tabs) {
      if (tab.contentType === 'terminal' && !liveTabs.has(tab.entityId)) {
        liveTabs.set(tab.entityId, { worktreeId, rowPtyId: null })
      }
    }
  }
  return liveTabs
}

function hasOwnerOutsideTargets(
  ownerTabIds: ReadonlySet<string> | undefined,
  targetIds: ReadonlySet<string>
): boolean {
  for (const ownerTabId of ownerTabIds ?? []) {
    if (!targetIds.has(ownerTabId)) {
      return true
    }
  }
  return false
}

function getProviderOwnership(
  state: TerminalTabRetirementState,
  worktreeId: string | null
): { kind: 'local-or-ssh' } | { kind: 'runtime'; environmentId: string } | { kind: 'unresolved' } {
  if (!worktreeId) {
    return { kind: 'unresolved' }
  }
  if (parseWorkspaceKey(worktreeId)?.type === 'folder') {
    const parsed = parseExecutionHostId(getExecutionHostIdForWorktree(state, worktreeId))
    return parsed?.kind === 'runtime'
      ? { kind: 'runtime', environmentId: parsed.environmentId }
      : parsed?.kind === 'local' || parsed?.kind === 'ssh'
        ? { kind: 'local-or-ssh' }
        : { kind: 'unresolved' }
  }
  const resolution = resolveWorktreeOperationRouteResult(state, worktreeId)
  if (resolution.kind !== 'resolved') {
    return { kind: 'unresolved' }
  }
  if (resolution.route.runtimeEnvironmentId) {
    return { kind: 'runtime', environmentId: resolution.route.runtimeEnvironmentId }
  }
  const parsed = parseExecutionHostId(resolution.route.executionHostId)
  return parsed?.kind === 'local' || parsed?.kind === 'ssh'
    ? { kind: 'local-or-ssh' }
    : { kind: 'unresolved' }
}

export function isTerminalTabPresent(
  state: Pick<AppState, 'tabsByWorktree'>,
  tabId: string
): boolean {
  return Object.values(state.tabsByWorktree).some((tabs) => tabs.some((tab) => tab.id === tabId))
}

export function buildTerminalTabRetirementPlan(
  state: TerminalTabRetirementState,
  tabId: string
): TerminalTabRetirementPlan {
  return buildTerminalTabRetirementPlans(state, [tabId]).get(tabId)!
}

export function buildTerminalTabRetirementPlans(
  state: TerminalTabRetirementState,
  tabIds: readonly string[]
): Map<string, TerminalTabRetirementPlan> {
  const targetIds = [...new Set(tabIds)]
  const targetIdSet = new Set(targetIds)
  const liveTabs = collectLiveTerminalTabs(state)
  const ptyIdsByLiveTab = new Map<string, string[]>()
  const ownerTabIdsByIdentity = new Map<string, Set<string>>()

  // Why: bulk close must not rebuild the live-owner index after every tab;
  // one snapshot keeps planning linear while preserving shared-surface safety.
  for (const [tabId, owner] of liveTabs) {
    const ptyIds = collectPtyIdsForTab(state, tabId, owner.rowPtyId)
    ptyIdsByLiveTab.set(tabId, ptyIds)
    for (const ptyId of ptyIds) {
      const identity = getTerminalPtyOwnershipIdentity(state, ptyId, owner.worktreeId)
      const owners = ownerTabIdsByIdentity.get(identity) ?? new Set<string>()
      owners.add(tabId)
      ownerTabIdsByIdentity.set(identity, owners)
    }
  }

  const plans = new Map<string, TerminalTabRetirementPlan>()
  const scheduledPtyOwners = new Set<string>()
  for (const tabId of targetIds) {
    const owner = liveTabs.get(tabId)
    const worktreeId = owner?.worktreeId ?? null
    const ptyIds =
      ptyIdsByLiveTab.get(tabId) ?? collectPtyIdsForTab(state, tabId, owner?.rowPtyId ?? null)
    const sharedPtyIds: string[] = []
    const localOrSshPtyIds: string[] = []
    const runtimeTerminals: TerminalTabRetirementPlan['runtimeTerminals'] = []
    const cleanupOnlyPtyIds: string[] = []
    const unroutablePtyIds: string[] = []
    const providerOwnership = getProviderOwnership(state, worktreeId)

    for (const ptyId of ptyIds) {
      const ownerIdentity = getTerminalPtyOwnershipIdentity(state, ptyId, worktreeId)
      const ownerTabIds = ownerTabIdsByIdentity.get(ownerIdentity)
      if (hasOwnerOutsideTargets(ownerTabIds, targetIdSet)) {
        sharedPtyIds.push(ptyId)
        continue
      }
      if (scheduledPtyOwners.has(ownerIdentity)) {
        // Why: another closing tab already owns provider teardown, but this
        // tab can still hold alias-keyed snapshots that must be discarded.
        cleanupOnlyPtyIds.push(ptyId)
        continue
      }
      scheduledPtyOwners.add(ownerIdentity)
      const remote = parseRemoteRuntimePtyId(ptyId)
      if (remote) {
        if (!remote.handle) {
          unroutablePtyIds.push(ptyId)
          continue
        }
        runtimeTerminals.push({
          ptyId,
          environmentId: remote.environmentId?.trim() || null,
          handle: remote.handle
        })
      } else if (ptyId.startsWith('remote:')) {
        unroutablePtyIds.push(ptyId)
      } else if (providerOwnership.kind !== 'local-or-ssh') {
        // Why: HUB-native wake hints are not paired-client PTY ids; wait for pane resolution instead of killing the same-looking local id.
        unroutablePtyIds.push(ptyId)
      } else {
        localOrSshPtyIds.push(ptyId)
      }
    }

    plans.set(tabId, {
      tabId,
      worktreeId,
      ptyIds,
      localOrSshPtyIds,
      runtimeTerminals,
      cleanupOnlyPtyIds,
      sharedPtyIds,
      unroutablePtyIds
    })
  }
  return plans
}

export function removeSleepingAgentSessionsForTab(
  records: Record<string, SleepingAgentSessionRecord>,
  tabId: string
): Record<string, SleepingAgentSessionRecord> {
  let next = records
  for (const [paneKey, record] of Object.entries(records)) {
    if (!paneKey.startsWith(`${tabId}:`) && record.tabId !== tabId) {
      continue
    }
    if (next === records) {
      next = { ...records }
    }
    delete next[paneKey]
  }
  return next
}
