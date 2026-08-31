import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { parseAppSshPtyId } from '../../../../shared/ssh-pty-id'
import type { TerminalSlice, TerminalStoreGet, TerminalStoreSet } from './terminal-state'
import { isCurrentDirectSshAuthority } from './terminal-pty-identities'
import {
  buildWorkspaceTerminalReconnectOwnerResolver,
  type WorkspaceTerminalReconnectOwnerResolution
} from './workspace-terminal-reconnect-owner'

/** Explicit app SSH ids must name the owner we are about to reattach. Legacy
 * relay ids without the `ssh:` envelope remain valid and are checked by the
 * connection selected by the caller. */
function persistedSshPtyMatchesTarget(
  ptyId: string | null | undefined,
  targetId: string | null | undefined,
  requireExplicitTarget = false
): boolean {
  if (requireExplicitTarget) {
    const parsed = parseAppSshPtyId(ptyId ?? '')
    return parsed !== null && targetId != null && parsed.connectionId === targetId
  }
  if (!ptyId || !ptyId.startsWith('ssh:')) {
    return true
  }
  const parsed = parseAppSshPtyId(ptyId)
  return parsed !== null && targetId != null && parsed.connectionId === targetId
}

/** A scoped pull may use its explicit authority only while the loaded owner agrees. */
function resolvedOwnerMatchesDirectSshTarget(
  owner: WorkspaceTerminalReconnectOwnerResolution,
  targetId: string
): boolean {
  return owner.kind !== 'resolved' || owner.sshTargetId === targetId
}

export function createWorkspaceTerminalReconnectActions(
  set: TerminalStoreSet,
  get: TerminalStoreGet
): Pick<TerminalSlice, 'reconnectPersistedTerminals'> {
  return {
    reconnectPersistedTerminals: async (signal, options) => {
      if (
        signal?.aborted ||
        (options && !isCurrentDirectSshAuthority(get(), options.directSshAuthority))
      ) {
        return
      }
      const {
        pendingReconnectWorktreeIds,
        pendingReconnectTabByWorktree,
        pendingReconnectPtyIdByTabId,
        terminalLayoutsByTabId,
        tabsByWorktree,
        ptyIdsByTabId
      } = get()
      const scopedWorkspaceKeys = options ? new Set(options.workspaceKeys) : null
      const ids = (pendingReconnectWorktreeIds ?? []).filter(
        (id) => !scopedWorkspaceKeys || scopedWorkspaceKeys.has(id)
      )
      if (ids.length === 0) {
        if (options) {
          return
        }
        set({
          workspaceSessionReady: true,
          pendingReconnectWorktreeIds: [],
          pendingReconnectTabByWorktree: {},
          pendingReconnectPtyIdByTabId: {}
        })
        return
      }
      // Why: defer daemon attachment for real dimensions; eager 80×24 flushes garble output.
      let reconnectedTabsByWorktree: Record<string, TerminalTab[]> | null = null
      let reconnectedPtyIdsByTabId: Record<string, string[]> | null = null
      // Why indexed: the loop neither sets state nor awaits, so one index over the
      // whole store snapshot serves every iteration.
      const resolveOwner = buildWorkspaceTerminalReconnectOwnerResolver(
        get().repos,
        get().worktreesByRepo
      )
      for (const workspaceSessionKey of ids) {
        const tabs = tabsByWorktree[workspaceSessionKey] ?? []
        const owner = resolveOwner(workspaceSessionKey)
        if (
          options &&
          !resolvedOwnerMatchesDirectSshTarget(owner, options.directSshAuthority.targetId)
        ) {
          // The catalog may have changed after direct scope selection. Do not
          // let a stale authority reattach a PTY under a newly different owner.
          continue
        }
        // Without an explicit direct-SSH scope, a cold-catalog collision cannot
        // identify which daemon owns the persisted PTY. Fail closed.
        if (owner.kind === 'ambiguous' && !options) {
          continue
        }
        const connectionId = owner.kind === 'resolved' ? (owner.connectionId ?? null) : null
        const ownerSshTargetId =
          owner.kind === 'resolved' ? (owner.sshTargetId ?? connectionId) : null
        // Why: only allow deferred reattach when the SSH connection is active; reattaching to a not-yet-connected relay (deferred/passphrase targets) would fail.
        const sshTargetId = options?.directSshAuthority.targetId ?? ownerSshTargetId
        const sshState = sshTargetId ? get().sshConnectionStates.get(sshTargetId) : null
        const sshConnected = sshTargetId != null && sshState?.status === 'connected'
        const supportsDeferredReattach = options ? sshConnected : !connectionId || sshConnected
        console.debug(
          `[reconnect-terminals] worktree=${workspaceSessionKey} connectionId=${connectionId} sshStatus=${sshState?.status} supportsDeferredReattach=${supportsDeferredReattach}`
        )
        const targetTabIds = pendingReconnectTabByWorktree[workspaceSessionKey] ?? []
        const tabsToReconnect: TerminalTab[] =
          targetTabIds.length > 0
            ? targetTabIds
                .map((id) => tabs.find((t) => t.id === id))
                .filter((t): t is TerminalTab => t != null)
            : tabs.slice(0, 1)
        if (tabsToReconnect.length === 0) {
          continue
        }
        for (const tab of tabsToReconnect) {
          const tabId = tab.id
          const layout = terminalLayoutsByTabId[tabId]
          const leafPtyMap = layout?.ptyIdsByLeafId ?? {}
          const pendingPtyId = pendingReconnectPtyIdByTabId[tabId]
          const expectedSshTargetId = options?.directSshAuthority.targetId ?? ownerSshTargetId
          const tabLevelPtyId = persistedSshPtyMatchesTarget(
            pendingPtyId,
            expectedSshTargetId,
            Boolean(options)
          )
            ? pendingPtyId
            : undefined
          const hasLeafMappings = Object.keys(leafPtyMap).length > 0
          // Why: publish live PTY hints before mount; pty-connection reattaches later.
          console.debug(
            `[reconnect-terminals] tab=${tabId} tabLevelPtyId=${tabLevelPtyId} supportsDeferredReattach=${supportsDeferredReattach} hasLeafMappings=${hasLeafMappings}`
          )
          // Why: populate ptyIdsByTabId so the sessions status segment maps daemon IDs to tabs; otherwise all sessions look like orphans until the pane mounts.
          // A row whose tab.ptyId went to the canonical row has no tab-level id left, but its own leaf PTYs still need advertising.
          const allPtyIds = hasLeafMappings
            ? (Object.values(leafPtyMap).filter(
                (ptyId): ptyId is string =>
                  Boolean(ptyId) &&
                  persistedSshPtyMatchesTarget(ptyId, expectedSshTargetId, Boolean(options))
              ) as string[])
            : tabLevelPtyId
              ? [tabLevelPtyId]
              : []
          if (allPtyIds.length > 0) {
            // Why: hide-sleeping reads ptyIdsByTabId for liveness; restored daemon sessions run before their pane remounts, so advertise them.
            reconnectedPtyIdsByTabId ??= { ...ptyIdsByTabId }
            reconnectedPtyIdsByTabId[tabId] = allPtyIds
          }
          if (tabLevelPtyId) {
            reconnectedTabsByWorktree ??= { ...tabsByWorktree }
            const nextTabs = reconnectedTabsByWorktree[workspaceSessionKey]
            if (!nextTabs) {
              continue
            }
            reconnectedTabsByWorktree[workspaceSessionKey] = nextTabs.map((t) =>
              t.id === tabId ? { ...t, ptyId: tabLevelPtyId } : t
            )
          }
        }
      }
      // Why: keep deferred SSH session IDs for post-cleanup reconnect.
      const scopedTabIds = new Set(
        [...(scopedWorkspaceKeys ?? ids)].flatMap((workspaceKey) =>
          (tabsByWorktree[workspaceKey] ?? []).map((tab) => tab.id)
        )
      )
      const deferredSshSessionIdsByTabId: Record<string, string> = options
        ? Object.fromEntries(
            Object.entries(get().deferredSshSessionIdsByTabId).filter(
              ([tabId]) => !scopedTabIds.has(tabId)
            )
          )
        : {}
      for (const workspaceSessionKey of ids) {
        const owner = resolveOwner(workspaceSessionKey)
        if (
          options &&
          !resolvedOwnerMatchesDirectSshTarget(owner, options.directSshAuthority.targetId)
        ) {
          continue
        }
        // A direct-SSH snapshot carries its own authoritative target even while
        // the catalog is cold or has colliding repo ids.
        const connectionId =
          options?.directSshAuthority.targetId ??
          (owner.kind === 'resolved'
            ? (owner.sshTargetId ?? owner.connectionId ?? undefined)
            : undefined)
        if (!connectionId) {
          continue
        }
        // Why: a repo can outlive its SSH target when the target was removed out of
        // band (a crash between removal and cleanup, or edited out of the config).
        // Once the authoritative target list has loaded, don't re-defer sessions for
        // a target it no longer lists — a stranded deferred id reads as liveness and
        // the orphan sweep could never remove the dead tab. Defer while the list is
        // still unknown so a normal cold-start reconnect isn't dropped (#9911).
        if (get().sshTargetsHydrated && !get().sshTargetLabels.has(connectionId)) {
          continue
        }
        const sshConnected = get().sshConnectionStates.get(connectionId)?.status === 'connected'
        if (sshConnected) {
          continue
        }
        const tabs = tabsByWorktree[workspaceSessionKey] ?? []
        for (const tab of tabs) {
          const sessionId = pendingReconnectPtyIdByTabId[tab.id]
          if (
            sessionId &&
            persistedSshPtyMatchesTarget(sessionId, connectionId, Boolean(options))
          ) {
            deferredSshSessionIdsByTabId[tab.id] = sessionId
          }
        }
      }
      if (
        signal?.aborted ||
        (options && !isCurrentDirectSshAuthority(get(), options.directSshAuthority))
      ) {
        return
      }
      const remainingReconnectWorktreeIds = options
        ? pendingReconnectWorktreeIds.filter((id) => !scopedWorkspaceKeys?.has(id))
        : []
      const remainingReconnectTabByWorktree = options
        ? Object.fromEntries(
            Object.entries(pendingReconnectTabByWorktree).filter(
              ([workspaceKey]) => !scopedWorkspaceKeys?.has(workspaceKey)
            )
          )
        : {}
      const remainingReconnectPtyIdByTabId = options
        ? Object.fromEntries(
            Object.entries(pendingReconnectPtyIdByTabId).filter(
              ([tabId]) => !scopedTabIds.has(tabId)
            )
          )
        : {}
      set({
        ...(reconnectedTabsByWorktree ? { tabsByWorktree: reconnectedTabsByWorktree } : {}),
        ...(reconnectedPtyIdsByTabId ? { ptyIdsByTabId: reconnectedPtyIdsByTabId } : {}),
        ...(options ? {} : { workspaceSessionReady: true }),
        pendingReconnectWorktreeIds: remainingReconnectWorktreeIds,
        pendingReconnectTabByWorktree: remainingReconnectTabByWorktree,
        pendingReconnectPtyIdByTabId: remainingReconnectPtyIdByTabId,
        deferredSshSessionIdsByTabId
      })
    }
  }
}
