import type { WorkspaceKey } from '../../../../shared/folder-workspace-types'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import {
  folderWorkspaceKey,
  isWorkspaceKey,
  worktreeWorkspaceKey
} from '../../../../shared/workspace-scope'
import { buildByIdIndex } from '../slices/worktree-by-id-index'
import { addAdditionalValidWorkspaceKeys } from '@/lib/workspace-session-hydration-keys'
import {
  buildValidWorktreeIdsForSessionHydration,
  collectPersistedWorktreeIdsForSessionHydration
} from '../../../../shared/worktree/degraded-repo-worktree-validity'
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
import { retainUnverifiedPtyLossTabIds } from './terminal-unverified-pty-loss'
import { restoreActiveTabIdByWorktree } from './workspace-terminal-active-tabs'
import { retainPairedTerminalTabCloseIntentsForCatalog } from '../../runtime/paired-terminal-tab-close-intents'

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
        // Floating Workspace uses session hydration despite being repo-less so daemon PTYs survive restart.
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
        } = buildWorkspaceTerminalRowPlan(session, validWorktreeIds)
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
          // An empty workspace is valid; fall back from active repo to avoid a blank landing screen.
          return fallbackActiveWorktreeId
        })()
        // Derive from the restored worktree; older builds could persist a key naming another workspace.
        const activeWorkspaceKey: WorkspaceKey | null = activeWorktreeId
          ? isWorkspaceKey(activeWorktreeId)
            ? activeWorktreeId
            : worktreeWorkspaceKey(activeWorktreeId)
          : null
        const activeWorkspaceExecutionHostId =
          activeWorkspaceKey && session.activeWorkspaceExecutionHostId
            ? session.activeWorkspaceExecutionHostId
            : null
        // Follow the canonical row that inherited the PTY or restart loses focus on a still-mounted session.
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
        const activeTabIdByWorktree = restoreActiveTabIdByWorktree({
          session,
          validWorktreeIds,
          validTabIds,
          canonicalTabIdBySubsumedTabId,
          tabsByWorktree,
          activeWorktreeId,
          activeTabId
        })
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
        // Index once: flattening tabs per persisted layout costs O(tabs × layouts).
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
          // Mid-session SSH pulls omit the shadow; clearing it would lose co-claimant rows needed by the next write.
          ...(options?.contestedHostWorkspaceSessions
            ? { contestedHostWorkspaceSessions: options.contestedHostWorkspaceSessions }
            : {}),
          ...(options?.contestedPrimaryHostBySessionKey
            ? { contestedPrimaryHostBySessionKey: options.contestedPrimaryHostBySessionKey }
            : {}),
          ...(options?.hydratedRuntimeSessionHostIds
            ? { hydratedRuntimeSessionHostIds: options.hydratedRuntimeSessionHostIds }
            : {}),
          repos: runtimeSessionPlaceholders.repos,
          tabsByWorktree,
          worktreesByRepo,
          // Prune focus recency only after hydration in App.tsx; SSH listings may still be arriving.
          lastVisitedAtByWorktreeId: session.lastVisitedAtByWorktreeId ?? {},
          // Missing write-once markers mean an older writer, not that defaults were never applied (#18117).
          defaultTerminalTabsAppliedByWorktreeId: {
            ...session.defaultTerminalTabsAppliedByWorktreeId,
            ...s.defaultTerminalTabsAppliedByWorktreeId
          },
          // Only main’s session carries close records; SSH pull hydration must preserve the mirror when absent.
          closedTerminalTabTombstonesByTabId:
            session.closedTerminalTabTombstonesByTabId ?? s.closedTerminalTabTombstonesByTabId,
          // Pull merges omit intents; only startup replaces them wholesale before snapshots can hide tabs. Filter against any catalog already loaded to discard servers removed while closed.
          pairedTerminalTabCloseIntentsByEnvironment: retainPairedTerminalTabCloseIntentsForCatalog(
            session.pairedTerminalTabCloseIntentsByEnvironment ??
              s.pairedTerminalTabCloseIntentsByEnvironment,
            {
              hydrated: s.runtimeEnvironmentCatalogHydrated,
              environmentIds: s.runtimeEnvironments.map((environment) => environment.id)
            }
          ),
          automaticAgentResumeClaimsByTabId: {},
          sleepingAgentSessionsByPaneKey,
          pendingReconnectWorktreeIds,
          pendingReconnectTabByWorktree,
          pendingReconnectPtyIdByTabId,
          everActivatedWorktreeIds: nextEverActivated,
          unverifiedPtyLossTabIds: retainUnverifiedPtyLossTabIds(
            s.unverifiedPtyLossTabIds,
            validTabIds
          ),
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
          }),
          localOnlyScrollbackByTabId: Object.fromEntries(
            Object.entries(session.localOnlyScrollbackByTabId ?? {}).filter(([tabId]) =>
              validTabIds.has(tabId)
            )
          )
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
