import { terminalPtyMembership } from './terminal-pty-membership'
import {
  isRemoteRuntimePtyId,
  parseRemoteRuntimePtyId
} from '../../../../shared/remote-runtime/remote-runtime-pty-id'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import type { AppState } from '../types'
import { resolveTerminalHostOwnership } from '@/lib/workspace/ownership/terminal-worktree-route'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { isEphemeralSetupTerminalWorktreeId } from '../../../../shared/ephemeral-setup-terminal-worktree-id'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { locateTerminalTab } from './terminal-tab-location'
import {
  collectPtyIdsForTab,
  getTerminalPtyOwnershipIdentity,
  type TerminalTabRetirementState
} from './terminal-tab-pty-ownership'
export {
  collectPtyIdsForTab,
  getTerminalPtyOwnershipIdentity,
  type TerminalTabRetirementState
} from './terminal-tab-pty-ownership'

export type TerminalTabCloseReason = 'user' | 'cleanup' | 'pty-exit'

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

/** Worktree-id shape for diagnostics; raw ids embed absolute paths and must not be logged. */
export function classifyTerminalRetirementWorktree(
  worktreeId: string | null
): 'floating' | 'ephemeral-setup' | 'folder-workspace' | 'worktree' | 'absent' {
  if (!worktreeId) {
    return 'absent'
  }
  if (worktreeId === FLOATING_TERMINAL_WORKTREE_ID) {
    return 'floating'
  }
  if (isEphemeralSetupTerminalWorktreeId(worktreeId)) {
    return 'ephemeral-setup'
  }
  return parseWorkspaceKey(worktreeId)?.type === 'folder' ? 'folder-workspace' : 'worktree'
}

export function isTerminalTabPresent(
  state: Pick<AppState, 'tabsByWorktree'>,
  tabId: string
): boolean {
  return locateTerminalTab(state.tabsByWorktree, tabId) !== null
}

export function hasTerminalPtyOwnerOutsidePane(
  state: TerminalTabRetirementState,
  identity: string,
  tabId: string,
  excludedLeafId?: string
): boolean {
  const membership = terminalPtyMembership(state)
  if (membership.hasCanonicalOwnerOutside(identity, tabId)) {
    return true
  }
  const owner = membership.view(tabId)
  return (
    owner !== undefined &&
    Object.entries(state.terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId ?? {}).some(
      ([leafId, ptyId]) =>
        leafId !== excludedLeafId &&
        getTerminalPtyOwnershipIdentity(state, ptyId, owner.worktreeId) === identity
    )
  )
}

export function buildTerminalTabRetirementPlan(
  state: TerminalTabRetirementState,
  tabId: string
): TerminalTabRetirementPlan {
  const membership = terminalPtyMembership(state)
  return buildRetirementPlan(
    state,
    tabId,
    membership.view(tabId),
    (identity) => membership.hasCanonicalOwnerOutside(identity, tabId),
    new Set()
  )
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
    plans.set(
      tabId,
      buildRetirementPlan(
        state,
        tabId,
        owner
          ? {
              worktreeId: owner.worktreeId,
              ptyIds: ptyIdsByLiveTab.get(tabId)!
            }
          : undefined,
        (identity) => hasOwnerOutsideTargets(ownerTabIdsByIdentity.get(identity), targetIdSet),
        scheduledPtyOwners
      )
    )
  }
  return plans
}

function buildRetirementPlan(
  state: TerminalTabRetirementState,
  tabId: string,
  owner: { worktreeId: string; ptyIds: string[] } | undefined,
  shared: (identity: string) => boolean,
  scheduledPtyOwners: Set<string>
): TerminalTabRetirementPlan {
  const worktreeId = owner?.worktreeId ?? null
  const ptyIds = owner?.ptyIds ?? collectPtyIdsForTab(state, tabId, null)
  const sharedPtyIds: string[] = []
  const localOrSshPtyIds: string[] = []
  const runtimeTerminals: TerminalTabRetirementPlan['runtimeTerminals'] = []
  const cleanupOnlyPtyIds: string[] = []
  const unroutablePtyIds: string[] = []
  const providerOwnership = resolveTerminalHostOwnership(state, worktreeId, 'teardown')

  for (const ptyId of ptyIds) {
    const ownerIdentity = getTerminalPtyOwnershipIdentity(state, ptyId, worktreeId)
    if (shared(ownerIdentity)) {
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
    } else if (isRemoteRuntimePtyId(ptyId)) {
      unroutablePtyIds.push(ptyId)
    } else if (providerOwnership.kind !== 'local-or-ssh') {
      // Why: HUB-native wake hints are not paired-client PTY ids; wait for pane resolution instead of killing the same-looking local id.
      unroutablePtyIds.push(ptyId)
    } else {
      localOrSshPtyIds.push(ptyId)
    }
  }

  return {
    tabId,
    worktreeId,
    ptyIds,
    localOrSshPtyIds,
    runtimeTerminals,
    cleanupOnlyPtyIds,
    sharedPtyIds,
    unroutablePtyIds
  }
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
