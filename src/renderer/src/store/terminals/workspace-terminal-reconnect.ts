import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { parseAppSshPtyId } from '../../../../shared/ssh-pty-id'
import { buildByIdIndex, buildWorktreeByIdIndex } from '../slices/worktree-by-id-index'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree/id'
import type { TerminalSlice, TerminalStoreGet, TerminalStoreSet } from './terminal-state'
import { isCurrentDirectSshAuthority } from './terminal-pty-identities'

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
      const worktreeById = buildWorktreeByIdIndex(get().worktreesByRepo)
      const repoById = buildByIdIndex(get().repos)
      for (const worktreeId of ids) {
        const tabs = tabsByWorktree[worktreeId] ?? []
        const targetTabIds = pendingReconnectTabByWorktree[worktreeId] ?? []
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
          const tabLevelPtyId =
            options &&
            parseAppSshPtyId(pendingPtyId ?? '')?.connectionId !==
              options.directSshAuthority.targetId
              ? undefined
              : pendingPtyId
          const hasLeafMappings = Object.keys(leafPtyMap).length > 0
          // Why: publish live PTY hints before mount (pty-connection reattaches later) so the
          // sessions status segment maps daemon IDs to tabs; otherwise all sessions look like orphans until the pane mounts.
          // A row whose tab.ptyId went to the canonical row has no tab-level id left, but its own leaf PTYs still need advertising.
          const allPtyIds = hasLeafMappings
            ? (Object.values(leafPtyMap).filter(Boolean) as string[])
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
            const nextTabs = reconnectedTabsByWorktree[worktreeId]
            if (!nextTabs) {
              continue
            }
            reconnectedTabsByWorktree[worktreeId] = nextTabs.map((t) =>
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
      for (const worktreeId of ids) {
        const worktree = worktreeById.get(worktreeId)
        // Why: SSH worktrees aren't in worktreesByRepo at cold start; fall back to the repo id in the composite worktree id so sessions still reach the deferred map.
        const repoId = worktree?.repoId ?? getRepoIdFromWorktreeId(worktreeId)
        const repo = repoId ? (repoById.get(repoId) ?? null) : null
        const connectionId = options?.directSshAuthority.targetId ?? repo?.connectionId
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
        const tabs = tabsByWorktree[worktreeId] ?? []
        for (const tab of tabs) {
          const sessionId = pendingReconnectPtyIdByTabId[tab.id]
          if (
            sessionId &&
            (!options || parseAppSshPtyId(sessionId)?.connectionId === connectionId)
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
