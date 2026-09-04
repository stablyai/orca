import { useMemo, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import type {
  SessionGridFilter,
  SessionGridItem,
  SessionGridStateFilter
} from '../../../../shared/session-grid-types'
import {
  buildSessionGridListing,
  type SessionGridBucketCounts,
  type SessionGridFilterOption,
  type SessionGridItemsState
} from './session-grid-items-builder'
import {
  createSessionGridItemReuseCache,
  type SessionGridItemReuseCache
} from './session-grid-item-reuse-cache'
import {
  buildSessionGridWorktreeCatalog,
  type SessionGridWorktreeCatalog
} from './session-grid-worktree-catalog'

/**
 * The momentary lens the page owns as component state. Not persisted and not read from the
 * store: revealing is a management mode you should lose on the way out — so it is passed
 * in, and the hook's listener budget does not move.
 */
export type SessionGridLenses = {
  revealHidden?: boolean
}

export function useSessionsGridItems(lenses: SessionGridLenses = {}): {
  /** Cards under the active filter, in display order. */
  items: SessionGridItem[]
  /** Every card in display order; the drag reorder works on this list, not the filtered one. */
  allItems: SessionGridItem[]
  filterOptions: SessionGridFilterOption[]
  /** The persisted filter, or 'all' when it names a workspace that no longer exists. */
  activeFilter: SessionGridFilter
  /** Per-bucket tallies for the state chips. */
  stateCounts: SessionGridBucketCounts
  activeStateFilter: SessionGridStateFilter
  /** Hidden cards in the current workspace scope, revealed or not. */
  hiddenCount: number
  /** Stable across title/status ticks; what the toolbar and empty slots read. */
  worktreeCatalog: SessionGridWorktreeCatalog
} {
  // Why destructured to a primitive: the lens is the page's own component state, so the
  // caller hands a fresh object every render and the memos below must not key on it.
  const revealHidden = lenses.revealHidden ?? false
  // Why three bundles and not fifteen fields: zustand visits every listener on every
  // publication, so a burst costs `events x listeners x selector work`
  // (docs/reference/renderer-agent-status-performance.md). One shallow-compared bundle
  // per concern keeps that multiplier at four for the whole page.
  const sessionInputs = useAppStore(
    useShallow((state) => ({
      tabsByWorktree: state.tabsByWorktree,
      terminalLayoutsByTabId: state.terminalLayoutsByTabId,
      ptyIdsByTabId: state.ptyIdsByTabId,
      agentStatusByPaneKey: state.agentStatusByPaneKey,
      runtimePaneTitlesByTabId: state.runtimePaneTitlesByTabId,
      // Two more fields in a bundle that already exists, not a subscription per card:
      // the attention ladder needs the bell the tab bar and the Dock read.
      unreadTerminalTabs: state.unreadTerminalTabs,
      unreadAgentCompletionPanes: state.unreadAgentCompletionPanes,
      generatedTitlesEnabled: state.settings?.tabAutoGenerateTitle === true
    }))
  )
  // Why on its own: freshness ticks bump the epoch without replacing any map above, and
  // the dot state decays with it — same invalidation key the tab bar and sidebar use.
  const agentStatusEpoch = useAppStore((state) => state.agentStatusEpoch)
  // Why the three host fields belong in THIS bundle and not a fourth: they only feed the
  // worktree catalog, which is memoized on this bundle's identity — and every one of them is
  // a store value taken as-is, so `useShallow` still compares by reference.
  const workspaceCatalogs = useAppStore(
    useShallow((state) => ({
      worktreesByRepo: state.worktreesByRepo,
      repos: state.repos,
      folderWorkspaces: state.folderWorkspaces,
      projectGroups: state.projectGroups,
      sshTargetLabels: state.sshTargetLabels,
      runtimeEnvironments: state.runtimeEnvironments,
      hostSettingOverrides: state.settings?.hostSettingOverrides
    }))
  )
  const gridView = useAppStore(
    useShallow((state) => ({
      sessionsGridFilter: state.sessionsGridFilter,
      sessionsGridStateFilter: state.sessionsGridStateFilter,
      sessionsGridTabOrder: state.sessionsGridTabOrder,
      sessionsGridHiddenTabIds: state.sessionsGridHiddenTabIds
    }))
  )

  const worktreeCatalog = useMemo(
    () => buildSessionGridWorktreeCatalog(workspaceCatalogs),
    [workspaceCatalogs]
  )

  const listingState: SessionGridItemsState = useMemo(
    () => ({ ...sessionInputs, ...gridView, agentStatusEpoch, revealHidden }),
    [sessionInputs, gridView, agentStatusEpoch, revealHidden]
  )

  // Why lazy: `useRef(create())` would build a Map and two arrays on every render and throw
  // them away — allocation churn in the hook that exists to remove it, on a 33 ms cadence.
  const reuseCacheRef = useRef<SessionGridItemReuseCache | null>(null)
  const reuseCache = (reuseCacheRef.current ??= createSessionGridItemReuseCache())

  // Why mutating a ref from a memo is safe here, and not because builds are deterministic
  // (they are not: `resolveTerminalTabActivityStatus` reads a process-wide flag cache that
  // freezes `Date.now()` and is shared with the tab bar and sidebar, so an eviction between
  // two invocations can re-resolve freshness at a new `now`): reuse is decided field by
  // field, so a repeated or discarded invocation can only win or lose a reuse — the object
  // handed back always carries the values this build computed.
  const listing = useMemo(
    () => buildSessionGridListing(listingState, worktreeCatalog, reuseCache),
    [listingState, worktreeCatalog, reuseCache]
  )

  return useMemo(() => ({ ...listing, worktreeCatalog }), [listing, worktreeCatalog])
}
