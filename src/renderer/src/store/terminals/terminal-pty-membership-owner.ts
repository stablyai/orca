import {
  collectPtyIdsForTab,
  terminalPtyIdentityForOwner,
  type TerminalTabRetirementState
} from './terminal-tab-pty-ownership'
import { parseRemoteRuntimePtyId } from '../../../../shared/remote-runtime/remote-runtime-pty-id'
import { createTerminalTabOwnerIndex } from './terminal-tab-owner-index'
import {
  changedKeys,
  replaceMembership,
  outside,
  type Reverse
} from './terminal-pty-membership-deltas'
import { createTerminalMembershipRouteDomains } from './terminal-membership-route-domains'

type State = TerminalTabRetirementState
type View = { worktreeId: string; ptyIds: string[] }
const MEMBERSHIP_FIELDS = [
  'ptyIdsByTabId',
  'terminalLayoutsByTabId',
  'lastKnownRelayPtyIdByTabId',
  'deferredSshSessionIdsByTabId',
  'pendingReconnectPtyIdByTabId'
] as const

export function createTerminalPtyMembershipOwner() {
  let accepted: State | null = null
  const views = new Map<string, View>()
  const sources = new Map<
    string,
    {
      raw: Set<string>
      parking: Set<string>
      environments: Set<string>
      identities: Map<string, number>
      unscoped: Map<string, string>
    }
  >()
  const tabIdsByRawPtyId: Reverse = new Map()
  const parkingTabsByPtyId: Reverse = new Map()
  const parkingTabsByEnvironment: Reverse = new Map()
  const tabsByIdentity: Reverse = new Map()
  const unscopedTabsByWorkspace = new Map<string, Set<string>>()
  const unscopedWorkspaceByTab = new Map<string, string>()
  const terminal = createTerminalTabOwnerIndex()
  const unified = createTerminalTabOwnerIndex((row) =>
    row.contentType === 'terminal' ? (row.entityId ?? null) : null
  )
  const routes = createTerminalMembershipRouteDomains()

  function replaceTab(state: State, tabId: string): void {
    const oldWorkspace = unscopedWorkspaceByTab.get(tabId)
    const row = terminal.getLastTab(state.tabsByWorktree, tabId)
    const worktreeId =
      terminal.getOwner(state.tabsByWorktree, tabId) ??
      unified.getFirstOwner(state.unifiedTabsByWorktree, tabId)
    const ptyIds = worktreeId === null ? [] : collectPtyIdsForTab(state, tabId, row?.ptyId)
    const unscoped = ptyIds.some((ptyId) => {
      const parsed = parseRemoteRuntimePtyId(ptyId)
      return !!parsed?.handle && !parsed.environmentId?.trim()
    })
    const nextWorkspace = unscoped ? worktreeId : null
    if (oldWorkspace !== nextWorkspace) {
      if (oldWorkspace !== undefined) {
        const tabs = unscopedTabsByWorkspace.get(oldWorkspace)!
        tabs.delete(tabId)
        if (!tabs.size) {
          unscopedTabsByWorkspace.delete(oldWorkspace)
          routes.forget(oldWorkspace)
        }
      }
      unscopedWorkspaceByTab.delete(tabId)
      if (nextWorkspace !== null) {
        const tabs = unscopedTabsByWorkspace.get(nextWorkspace) ?? new Set<string>()
        tabs.add(tabId)
        unscopedTabsByWorkspace.set(nextWorkspace, tabs)
        unscopedWorkspaceByTab.set(tabId, nextWorkspace)
      }
    }
    const owner =
      nextWorkspace === null ? { kind: 'non-runtime' as const } : routes.owner(state, nextWorkspace)
    const identities = new Map<string, number>()
    const unscopedIds = new Map<string, string>()
    for (const ptyId of ptyIds) {
      const identity = terminalPtyIdentityForOwner(ptyId, owner)
      identities.set(identity, (identities.get(identity) ?? 0) + 1)
      const parsed = parseRemoteRuntimePtyId(ptyId)
      if (parsed?.handle && !parsed.environmentId?.trim()) {
        unscopedIds.set(ptyId, identity)
      }
    }
    const raw = new Set(ptyIds)
    for (const tab of terminal.getRows(state.tabsByWorktree, tabId)) {
      if (tab.ptyId) {
        raw.add(tab.ptyId)
      }
    }
    const parkingRow = terminal.getTab(state.tabsByWorktree, tabId)
    const parking = new Set(
      parkingRow
        ? [
            ...(parkingRow.ptyId ? [parkingRow.ptyId] : []),
            ...(state.ptyIdsByTabId[tabId] ?? []),
            ...Object.values(state.terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId ?? {}),
            ...(state.lastKnownRelayPtyIdByTabId[tabId]
              ? [state.lastKnownRelayPtyIdByTabId[tabId]]
              : [])
          ]
        : []
    )
    const environments = new Set<string>()
    for (const id of parking) {
      const env = parseRemoteRuntimePtyId(id)?.environmentId
      if (env) {
        environments.add(env)
      }
    }
    const before = sources.get(tabId)
    replaceMembership(tabIdsByRawPtyId, tabId, before?.raw ?? new Set(), raw)
    replaceMembership(parkingTabsByPtyId, tabId, before?.parking ?? new Set(), parking)
    replaceMembership(
      parkingTabsByEnvironment,
      tabId,
      before?.environments ?? new Set(),
      environments
    )
    replaceMembership(tabsByIdentity, tabId, before?.identities ?? new Set(), identities)
    if (worktreeId === null) {
      views.delete(tabId)
      sources.delete(tabId)
    } else {
      views.set(tabId, { worktreeId, ptyIds })
      sources.set(tabId, { raw, parking, environments, identities, unscoped: unscopedIds })
    }
  }

  return {
    accept(state: State): void {
      if (accepted === state) {
        return
      }
      const previous = accepted
      const changedTabs = new Set<string>()
      const affectedRoutes = routes.accept(previous, state)
      if (previous?.tabsByWorktree !== state.tabsByWorktree) {
        const changes = previous
          ? changedKeys(previous.tabsByWorktree, state.tabsByWorktree)
          : { keys: Object.keys(state.tabsByWorktree), reordered: true }
        const keys = [...changes.keys]
        let sameTopology = !changes.reordered
        for (const id of keys) {
          const before = previous?.tabsByWorktree[id] ?? []
          const after = state.tabsByWorktree[id] ?? []
          const sameIds =
            before.length === after.length && after.every((row, at) => row.id === before[at].id)
          if (!sameIds || !!previous?.tabsByWorktree[id] !== !!state.tabsByWorktree[id]) {
            sameTopology = false
          }
          if (
            !changes.reordered &&
            sameIds &&
            after.every((row, at) => row.ptyId === before[at].ptyId)
          ) {
            continue
          }
          for (const tab of before) {
            changedTabs.add(tab.id)
          }
          for (const tab of after) {
            changedTabs.add(tab.id)
          }
        }
        if (previous && sameTopology) {
          terminal.adoptMetadataOnlyBucketReplacements(
            previous.tabsByWorktree,
            state.tabsByWorktree,
            keys
          )
        }
        terminal.getOwners(state.tabsByWorktree)
      }
      if (previous?.unifiedTabsByWorktree !== state.unifiedTabsByWorktree) {
        const changes = previous
          ? changedKeys(previous.unifiedTabsByWorktree, state.unifiedTabsByWorktree)
          : { keys: Object.keys(state.unifiedTabsByWorktree), reordered: true }
        const keys = [...changes.keys]
        let sameTopology = !changes.reordered
        for (const id of keys) {
          const before = previous?.unifiedTabsByWorktree[id] ?? []
          const after = state.unifiedTabsByWorktree[id] ?? []
          if (
            before.length !== after.length ||
            !!previous?.unifiedTabsByWorktree[id] !== !!state.unifiedTabsByWorktree[id] ||
            !after.every(
              (row, at) =>
                row.contentType === before[at].contentType && row.entityId === before[at].entityId
            )
          ) {
            sameTopology = false
          }
          const oldTerminals = before.filter((row) => row.contentType === 'terminal')
          const nextTerminals = after.filter((row) => row.contentType === 'terminal')
          if (
            !changes.reordered &&
            oldTerminals.length === nextTerminals.length &&
            nextTerminals.every((row, at) => row.entityId === oldTerminals[at].entityId)
          ) {
            continue
          }
          for (const tab of oldTerminals) {
            changedTabs.add(tab.entityId)
          }
          for (const tab of nextTerminals) {
            changedTabs.add(tab.entityId)
          }
        }
        if (previous && sameTopology) {
          unified.adoptMetadataOnlyBucketReplacements(
            previous.unifiedTabsByWorktree,
            state.unifiedTabsByWorktree,
            keys
          )
        }
        unified.getOwners(state.unifiedTabsByWorktree)
      }
      if (previous) {
        for (const field of MEMBERSHIP_FIELDS) {
          if (previous[field] !== state[field]) {
            for (const id of changedKeys(previous[field], state[field]).keys) {
              if (
                field === 'terminalLayoutsByTabId' &&
                previous.terminalLayoutsByTabId[id]?.ptyIdsByLeafId ===
                  state.terminalLayoutsByTabId[id]?.ptyIdsByLeafId
              ) {
                continue
              }
              changedTabs.add(id)
            }
          }
        }
      }
      for (const tabId of changedTabs) {
        replaceTab(state, tabId)
      }
      for (const workspace of affectedRoutes) {
        const tabs = unscopedTabsByWorkspace.get(workspace)
        if (!tabs) {
          continue
        }
        const owner = routes.owner(state, workspace)
        for (const tabId of tabs) {
          if (changedTabs.has(tabId)) {
            continue
          }
          const source = sources.get(tabId)!
          for (const [ptyId, before] of source.unscoped) {
            const after = terminalPtyIdentityForOwner(ptyId, owner)
            if (before === after) {
              continue
            }
            const count = source.identities.get(before)!
            if (count > 1) {
              source.identities.set(before, count - 1)
            } else {
              source.identities.delete(before)
              const tabs = tabsByIdentity.get(before)!
              tabs.delete(tabId)
              if (!tabs.size) {
                tabsByIdentity.delete(before)
              }
            }
            const afterCount = source.identities.get(after) ?? 0
            source.identities.set(after, afterCount + 1)
            if (!afterCount) {
              const tabs = tabsByIdentity.get(after) ?? new Set<string>()
              tabs.add(tabId)
              tabsByIdentity.set(after, tabs)
            }
            source.unscoped.set(ptyId, after)
          }
        }
      }
      accepted = state
    },
    view: (tabId: string): View | undefined => views.get(tabId),
    hasCanonicalOwnerOutside: (identity: string, tabId: string): boolean =>
      outside(tabsByIdentity, identity, tabId),
    hasRawOwnerOutside: (ptyId: string, tabId: string): boolean =>
      outside(tabIdsByRawPtyId, ptyId, tabId),
    parkingTabsForPty: (ptyId: string): Iterable<string> => parkingTabsByPtyId.get(ptyId) ?? [],
    parkingTabsForEnvironment: (environmentId: string): Iterable<string> =>
      parkingTabsByEnvironment.get(environmentId) ?? []
  }
}
