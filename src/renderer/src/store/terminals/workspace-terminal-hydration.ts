import type { WorkspaceKey } from '../../../../shared/folder-workspace-types'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import {
  folderWorkspaceKey,
  parseWorkspaceKey,
  worktreeWorkspaceKey
} from '../../../../shared/workspace-scope'
import { buildByIdIndex } from '../slices/worktree-by-id-index'
import { addAdditionalValidWorkspaceKeys } from '@/lib/workspace-session-hydration-keys'
import {
  buildValidWorktreeIdsForSessionHydration,
  collectPersistedWorktreeIdsForSessionHydration
} from '../slices/degraded-repo-worktree-validity'
import type { TerminalSlice, TerminalStoreGet, TerminalStoreSet } from './terminal-state'
import { buildRuntimeSessionPlaceholders } from './workspace-terminal-placeholders'
import {
  targetScopedWorkspaceHydrationPatch,
  transferNormalizedTerminalLayoutPtyOwnership,
  type TerminalLayoutPtyOwnershipTransfer,
  type WorkspaceHydrationPatch
} from './workspace-terminal-hydration-patch'
import { buildWorkspaceTerminalRowPlan } from './workspace-terminal-row-plan'
import { buildWorkspaceTerminalReconnectPlan } from './workspace-terminal-reconnect-plan'
import { buildWorkspaceTerminalLayoutPlan } from './workspace-terminal-layout-plan'
import { addHydratedSshWorktreePlaceholders } from './workspace-terminal-ssh-placeholders'

export function createWorkspaceTerminalHydrationActions(
  set: TerminalStoreSet,
  get: TerminalStoreGet
): Pick<TerminalSlice, 'hydrateWorkspaceSession'> {
  return {
    hydrateWorkspaceSession: (session, options) => {
      const ownershipTransferTabIds = options?.replaceWorkspaceKeys
        ? new Set(
            options.replaceWorkspaceKeys.flatMap((workspaceKey) =>
              (session.tabsByWorktree[workspaceKey] ?? []).map((tab) => tab.id)
            )
          )
        : null
      const ownershipTransfersByTabId = new Map<string, TerminalLayoutPtyOwnershipTransfer[]>()
      set((s) => {
        const runtimeSessionPlaceholders = buildRuntimeSessionPlaceholders({
          repos: s.repos,
          runtimeHostIdByWorkspaceSessionKey: options?.runtimeHostIdByWorkspaceSessionKey ?? {},
          worktreesByRepo: s.worktreesByRepo
        })
        const validWorktreeIds = buildValidWorktreeIdsForSessionHydration(
          {
            repos: runtimeSessionPlaceholders.repos,
            worktreesByRepo: runtimeSessionPlaceholders.worktreesByRepo,
            detectedWorktreesByRepo: s.detectedWorktreesByRepo
          },
          collectPersistedWorktreeIdsForSessionHydration(session)
        )
        const knownRepoIds = new Set(runtimeSessionPlaceholders.repos.map((r) => r.id))
        // Why: the Floating Workspace isn't a repo worktree, but its tabs use the normal session pipeline so daemon PTYs survive app restart.
        validWorktreeIds.add(FLOATING_TERMINAL_WORKTREE_ID)
        for (const workspace of s.folderWorkspaces) {
          validWorktreeIds.add(folderWorkspaceKey(workspace.id))
        }
        addAdditionalValidWorkspaceKeys(validWorktreeIds, options)
        const {
          canonicalTabIdBySubsumedTabId,
          reconnectPtyIdByRetainedTabId,
          releasedPtyIdsByTabId,
          sleepingAgentSessionsByPaneKey,
          tabsByWorktree,
          validTabIds
        } = buildWorkspaceTerminalRowPlan(session, validWorktreeIds, options)
        const fallbackActiveWorktreeId =
          !session.activeWorktreeId &&
          session.activeRepoId &&
          knownRepoIds.has(session.activeRepoId)
            ? (runtimeSessionPlaceholders.worktreesByRepo[session.activeRepoId]?.find(
                (worktree) => worktree.isMainWorktree
              )?.id ??
              runtimeSessionPlaceholders.worktreesByRepo[session.activeRepoId]?.[0]?.id ??
              null)
            : null
        const activeWorktreeId = (() => {
          if (session.activeWorktreeId && validWorktreeIds.has(session.activeWorktreeId)) {
            return session.activeWorktreeId
          }
          // Why: a workspace with no tabs is still valid; fall back from the active repo to avoid a blank landing screen when tabs were pruned or never created.
          return fallbackActiveWorktreeId
        })()
        const activeWorkspaceKey: WorkspaceKey | null =
          session.activeWorkspaceKey && validWorktreeIds.has(session.activeWorkspaceKey)
            ? session.activeWorkspaceKey
            : activeWorktreeId
              ? parseWorkspaceKey(activeWorktreeId)
                ? (activeWorktreeId as WorkspaceKey)
                : worktreeWorkspaceKey(activeWorktreeId)
              : null
        const activeWorkspaceExecutionHostId =
          activeWorkspaceKey && session.activeWorkspaceExecutionHostId
            ? session.activeWorkspaceExecutionHostId
            : null
        // Why: follow a subsumed row to the canonical twin that inherited its PTY, else the app
        // restarts with no active terminal even though the same session is still mounted.
        const restoredActiveTabId = session.activeTabId
          ? (canonicalTabIdBySubsumedTabId.get(session.activeTabId) ?? session.activeTabId)
          : null
        const activeTabId =
          restoredActiveTabId && validTabIds.has(restoredActiveTabId) ? restoredActiveTabId : null
        const activeRepoId =
          session.activeRepoId &&
          runtimeSessionPlaceholders.repos.some((repo) => repo.id === session.activeRepoId)
            ? session.activeRepoId
            : null
        const {
          pendingReconnectPtyIdByTabId,
          pendingReconnectTabByWorktree,
          pendingReconnectWorktreeIds
        } = buildWorkspaceTerminalReconnectPlan({
          reconnectPtyIdByRetainedTabId,
          releasedPtyIdsByTabId,
          repos: runtimeSessionPlaceholders.repos,
          session,
          validTabIds,
          validWorktreeIds,
          worktreesByRepo: runtimeSessionPlaceholders.worktreesByRepo
        })
        // Restore per-worktree active tab; validate ids when the map exists, else derive for legacy sessions.
        let activeTabIdByWorktree: Record<string, string | null> = {}
        if (session.activeTabIdByWorktree) {
          for (const [wId, tabId] of Object.entries(session.activeTabIdByWorktree)) {
            if (!validWorktreeIds.has(wId) || !tabId) {
              continue
            }
            // Why: a subsumed row's canonical twin holds the same PTY, so follow the pointer there
            // instead of forgetting which terminal the workspace last focused.
            const restored = validTabIds.has(tabId)
              ? tabId
              : canonicalTabIdBySubsumedTabId.get(tabId)
            if (restored && validTabIds.has(restored)) {
              activeTabIdByWorktree[wId] = restored
            }
          }
        } else {
          // Legacy sessions: best-effort derivation
          if (activeWorktreeId && activeTabId) {
            activeTabIdByWorktree[activeWorktreeId] = activeTabId
          }
          for (const [wId, tabs] of Object.entries(tabsByWorktree)) {
            if (!activeTabIdByWorktree[wId] && tabs.length > 0) {
              activeTabIdByWorktree[wId] = tabs[0].id
            }
          }
        }
        const worktreesByRepo = addHydratedSshWorktreePlaceholders(
          runtimeSessionPlaceholders.repos,
          runtimeSessionPlaceholders.worktreesByRepo,
          tabsByWorktree
        )
        // Why: record restored active worktrees to avoid suppressing later real activity.
        const nextEverActivated = new Set(s.everActivatedWorktreeIds)
        if (activeWorktreeId) {
          nextEverActivated.add(activeWorktreeId)
        }
        // Why indexed: the layout map below looks up a tab per persisted layout, and
        // re-flattening tabsByWorktree per entry is O(tabs x layouts).
        const allTabs = Object.values(tabsByWorktree).flat()
        const tabById = buildByIdIndex(allTabs)
        const hydrated: WorkspaceHydrationPatch = {
          activeRepoId,
          activeWorktreeId,
          activeWorkspaceKey,
          activeWorkspaceExecutionHostId,
          activeTabId,
          activeTabIdByWorktree,
          restoredRuntimeHostIdByWorkspaceSessionKey:
            options?.runtimeHostIdByWorkspaceSessionKey ?? {},
          repos: runtimeSessionPlaceholders.repos,
          tabsByWorktree,
          worktreesByRepo,
          // Why: restore the focus-recency map; pruning is deferred to App.tsx (post-hydration) because SSH worktrees may still be appearing in worktreesByRepo.
          lastVisitedAtByWorktreeId: session.lastVisitedAtByWorktreeId ?? {},
          defaultTerminalTabsAppliedByWorktreeId:
            session.defaultTerminalTabsAppliedByWorktreeId ?? {},
          // Why replace and not union: both callers hand over a map they derived from this store
          // synchronously (the pull merge) or from disk before the store had one (startup), so there
          // is no local tombstone to lose — and a union would resurrect the ones the merge just
          // retired on the host's acknowledgement, which is the whole bound on this map.
          closedTerminalTabTombstonesByTabId: session.closedTerminalTabTombstonesByTabId ?? {},
          automaticAgentResumeClaimsByTabId: {},
          sleepingAgentSessionsByPaneKey,
          pendingReconnectWorktreeIds,
          pendingReconnectTabByWorktree,
          pendingReconnectPtyIdByTabId,
          everActivatedWorktreeIds: nextEverActivated,
          // Why: seed hydrated active worktrees so the first activation has a Back target.
          worktreeNavHistory: activeWorktreeId ? [activeWorktreeId] : [],
          worktreeNavHistoryIndex: activeWorktreeId ? 0 : -1,
          ptyIdsByTabId: Object.fromEntries(allTabs.map((tab) => [tab.id, []] as const)),
          terminalLayoutsByTabId: buildWorkspaceTerminalLayoutPlan({
            ownershipTransfersByTabId,
            ownershipTransferTabIds,
            releasedPtyIdsByTabId,
            session,
            tabById,
            validTabIds
          })
        }
        return options?.replaceWorkspaceKeys
          ? targetScopedWorkspaceHydrationPatch(s, hydrated, session, options)
          : hydrated
      })
      for (const [tabId, transfers] of ownershipTransfersByTabId) {
        transferNormalizedTerminalLayoutPtyOwnership(get(), tabId, transfers)
      }
    }
  }
}
