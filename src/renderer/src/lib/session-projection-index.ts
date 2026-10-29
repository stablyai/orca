import { SessionRoutingCatalog } from './session-routing-catalog'
import type { HostSessionRouting } from './workspace-session-host-persistence'
import type { AppState } from '../store/types'
import { SESSION_RELEVANT_FIELDS } from './workspace-session'
import { buildWorkspaceSessionPatch } from './workspace-session-patch'
import { SESSION_MAP_FIELDS, type SessionMapField } from '../../../shared/session-change-set'
import { SessionUnitIndex } from '../../../shared/session-unit-index'
import type { WorkspaceSessionPatch } from '../../../shared/workspace-session-state-types'
import { groupSessionFiles, type SessionSourceField } from './session-source-fields'

import { parseAppSshPtyId } from '../../../shared/ssh-pty-id'
export const SOURCE_MAPS = {
  tabsByWorktree: 'tabsByWorktree',
  terminalLayoutsByTabId: 'terminalLayoutsByTabId',
  localOnlyScrollbackByTabId: 'localOnlyScrollbackByTabId',
  activeTabIdByWorktree: 'activeTabIdByWorktree',
  activeFileIdByWorktree: 'activeFileIdByWorktree',
  activeTabTypeByWorktree: 'activeTabTypeByWorktree',
  markdownFrontmatterVisible: 'markdownFrontmatterVisible',
  browserTabsByWorktree: 'browserTabsByWorktree',
  browserPagesByWorkspace: 'browserPagesByWorkspace',
  activeBrowserTabIdByWorktree: 'activeBrowserTabIdByWorktree',
  unifiedTabsByWorktree: 'unifiedTabs',
  groupsByWorktree: 'tabGroups',
  layoutByWorktree: 'tabGroupLayouts',
  activeGroupIdByWorktree: 'activeGroupIdByWorktree',
  lastVisitedAtByWorktreeId: 'lastVisitedAtByWorktreeId',
  defaultTerminalTabsAppliedByWorktreeId: 'defaultTerminalTabsAppliedByWorktreeId',
  sleepingAgentSessionsByPaneKey: 'sleepingAgentSessionsByPaneKey',
  clientHostedBrowserCloseIntentsByEnvironment: 'clientHostedBrowserCloseIntentsByEnvironment',
  pairedTerminalTabCloseIntentsByEnvironment: 'pairedTerminalTabCloseIntentsByEnvironment'
} as const satisfies Partial<Record<SessionSourceField, SessionMapField>>
export const RECONNECT_FIELDS = new Set<SessionSourceField>([
  'ptyIdsByTabId',
  'lastKnownRelayPtyIdByTabId',
  'pendingReconnectPtyIdByTabId',
  'deferredSshSessionIdsByTabId'
])
export type SessionProjectionUpdate = {
  patch: WorkspaceSessionPatch
  keys: ReadonlyMap<SessionMapField, ReadonlySet<string>>
  workspaces: ReadonlySet<string>
  connections?: ReadonlyMap<string, boolean>
  terminalOwners?: ReadonlyMap<string, string>
  full: boolean
  routing?: HostSessionRouting
  routingChanged?: boolean
}

/** Membership is rebuildable; source arrays and Records remain the only value authority. */

export class SessionProjectionIndex {
  protected index: SessionUnitIndex
  protected catalog: SessionRoutingCatalog
  protected readonly remoteConnectionByTab = new Map<string, string>()
  protected readonly remoteConnectionCounts = new Map<string, number>()
  constructor(state: AppState) {
    this.catalog = new SessionRoutingCatalog(state)
    this.index = new SessionUnitIndex(this.rawSession(state))
    const initial = buildWorkspaceSessionPatch(state, ['tabsByWorktree'])
    for (const [id, pty] of Object.entries(initial.remoteSessionIdsByTabId ?? {})) {
      this.replaceConnection(id, pty)
    }
  }
  protected replaceConnection(tabId: string, ptyId: string | undefined): void {
    const before = this.remoteConnectionByTab.get(tabId)
    if (before) {
      const count = (this.remoteConnectionCounts.get(before) ?? 0) - 1
      if (count) {
        this.remoteConnectionCounts.set(before, count)
      } else {
        this.remoteConnectionCounts.delete(before)
      }
    }
    const next = ptyId && parseAppSshPtyId(ptyId)?.connectionId
    if (next) {
      this.remoteConnectionByTab.set(tabId, next)
      this.remoteConnectionCounts.set(next, (this.remoteConnectionCounts.get(next) ?? 0) + 1)
    } else {
      this.remoteConnectionByTab.delete(tabId)
    }
  }
  protected terminalOwners(keys: ReadonlyMap<SessionMapField, ReadonlySet<string>>) {
    const owners = new Map<string, string>()
    for (const field of [
      'terminalLayoutsByTabId',
      'localOnlyScrollbackByTabId',
      'remoteSessionIdsByTabId'
    ] as const) {
      for (const id of keys.get(field) ?? []) {
        const owner = this.index.terminalOwner(id)
        if (owner !== undefined) {
          owners.set(id, owner)
        }
      }
    }
    return owners
  }
  protected rawSession(state: AppState) {
    const session = {
      activeRepoId: state.activeRepoId,
      activeWorktreeId: state.activeWorktreeId,
      activeTabId: state.activeTabId,
      tabsByWorktree: state.tabsByWorktree,
      terminalLayoutsByTabId: state.terminalLayoutsByTabId,
      openFilesByWorktree: Object.fromEntries(groupSessionFiles(state.openFiles))
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these are the fixed, exhaustive source-to-session map keys.
    for (const source of Object.keys(SOURCE_MAPS) as (keyof typeof SOURCE_MAPS)[]) {
      Object.assign(session, { [SOURCE_MAPS[source]]: state[source] })
    }
    return session
  }
  full(state: AppState): SessionProjectionUpdate {
    this.index = new SessionUnitIndex(this.rawSession(state))
    const patch = buildWorkspaceSessionPatch(state, SESSION_RELEVANT_FIELDS)
    const keys = new Map<SessionMapField, ReadonlySet<string>>()
    for (const field of SESSION_MAP_FIELDS) {
      if (patch[field] !== undefined) {
        keys.set(field, new Set(Object.keys(patch[field] ?? {})))
      }
    }
    return {
      patch,
      keys,
      terminalOwners: this.terminalOwners(keys),
      workspaces: new Set([
        ...Object.keys(state.tabsByWorktree),
        ...(patch.activeWorktreeIdsOnShutdown ?? [])
      ]),
      full: true,
      routing: this.catalog.routing,
      routingChanged: true
    }
  }
}
