import { isTerminalLeafId, makePaneKey } from '../../../../shared/stable-pane-id'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/terminal-tab-types'
import { terminalLayoutEqual } from '@/lib/terminal-layout-equality'
import {
  normalizeTerminalLayoutPtyOwnership,
  resolveTerminalLayoutPtyOwnershipTransfers
} from '@/components/terminal-pane/terminal-layout-pty-ownership'
import { transferDirectSshPaneDetachLedger } from '../slices/direct-ssh-terminal-authority-ledger'
import type { TerminalSlice, TerminalStoreGet, TerminalStoreSet } from './terminal-state'
import {
  isCurrentDirectSshAuthority,
  resolvePrimaryLayoutPtyId,
  uniquePtyIds,
  withTerminalTabPtyId
} from './terminal-pty-identities'
import { transferNormalizedTerminalLayoutPtyOwnership } from './workspace-terminal-hydration-patch'

function retainLaunchAgentLeafId(
  tabsByWorktree: Record<string, TerminalTab[]>,
  tabId: string,
  layout: TerminalLayoutSnapshot
): Record<string, TerminalTab[]> {
  const leafId = layout.root?.type === 'leaf' ? layout.root.leafId : null
  if (!leafId || !isTerminalLeafId(leafId)) {
    return tabsByWorktree
  }

  for (const [worktreeId, tabs] of Object.entries(tabsByWorktree)) {
    const tabIndex = tabs.findIndex((tab) => tab.id === tabId)
    if (tabIndex === -1) {
      continue
    }
    const tab = tabs[tabIndex]
    if (!tab?.launchAgent || tab.launchAgentLeafId === leafId) {
      return tabsByWorktree
    }
    const nextTabs = [...tabs]
    nextTabs[tabIndex] = { ...tab, launchAgentLeafId: leafId }
    return { ...tabsByWorktree, [worktreeId]: nextTabs }
  }
  return tabsByWorktree
}

export function createTerminalLayoutActions(
  set: TerminalStoreSet,
  get: TerminalStoreGet
): Pick<
  TerminalSlice,
  | 'replaceTerminalLayoutPanePtyId'
  | 'setTabPaneExpanded'
  | 'setTabCanExpandPane'
  | 'setTabLayout'
  | 'syncPaneDetachPtyOwnership'
> {
  return {
    replaceTerminalLayoutPanePtyId: (tabId, leafId, ptyId) => {
      set((s) => {
        const layout = s.terminalLayoutsByTabId[tabId]
        if (!layout || layout.ptyIdsByLeafId?.[leafId] === ptyId) {
          return {}
        }
        return {
          terminalLayoutsByTabId: {
            ...s.terminalLayoutsByTabId,
            [tabId]: {
              ...layout,
              ptyIdsByLeafId: { ...layout.ptyIdsByLeafId, [leafId]: ptyId }
            }
          }
        }
      })
    },
    setTabPaneExpanded: (tabId, expanded) => {
      set((s) => ({
        expandedPaneByTabId: { ...s.expandedPaneByTabId, [tabId]: expanded }
      }))
    },
    setTabCanExpandPane: (tabId, canExpand) => {
      set((s) => ({
        canExpandPaneByTabId: { ...s.canExpandPaneByTabId, [tabId]: canExpand }
      }))
    },
    setTabLayout: (tabId, layout) => {
      let ownershipTransfers: ReturnType<typeof resolveTerminalLayoutPtyOwnershipTransfers> = []
      set((s) => {
        if (!layout) {
          if (!(tabId in s.terminalLayoutsByTabId)) {
            return s
          }
          const next = { ...s.terminalLayoutsByTabId }
          delete next[tabId]
          return { terminalLayoutsByTabId: next }
        }
        const normalized = normalizeTerminalLayoutPtyOwnership(layout)
        // Resolved before the bailout: normalization can transfer pane ownership even when the stored snapshot is untouched.
        if (normalized.changed) {
          ownershipTransfers = resolveTerminalLayoutPtyOwnershipTransfers(
            layout,
            normalized.snapshot
          )
        }
        const existing = s.terminalLayoutsByTabId[tabId]
        const nextTabsByWorktree = retainLaunchAgentLeafId(
          s.tabsByWorktree,
          tabId,
          normalized.snapshot
        )
        const layoutChanged = !existing || !terminalLayoutEqual(existing, normalized.snapshot)
        const tabsChanged = nextTabsByWorktree !== s.tabsByWorktree
        // Why: pane-title churn re-persists structurally identical snapshots; bailing keeps every pane selector asleep.
        if (!layoutChanged && !tabsChanged) {
          return s
        }
        return {
          ...(layoutChanged
            ? {
                terminalLayoutsByTabId: {
                  ...s.terminalLayoutsByTabId,
                  [tabId]: normalized.snapshot
                }
              }
            : {}),
          ...(tabsChanged ? { tabsByWorktree: nextTabsByWorktree } : {})
        }
      })
      transferNormalizedTerminalLayoutPtyOwnership(get(), tabId, ownershipTransfers)
    },
    syncPaneDetachPtyOwnership: ({
      detachedLeafId,
      detachedPtyId,
      sourceLayout,
      sourceTabId,
      targetTabId
    }) => {
      const sourcePaneKey = makePaneKey(sourceTabId, detachedLeafId)
      const targetPaneKey = makePaneKey(targetTabId, detachedLeafId)
      set((s) => {
        const layoutSourcePtyIds = uniquePtyIds(Object.values(sourceLayout.ptyIdsByLeafId ?? {}))
        const existingSourcePtyIds = (s.ptyIdsByTabId[sourceTabId] ?? []).filter(
          (ptyId) => ptyId !== detachedPtyId
        )
        const sourcePtyIds =
          layoutSourcePtyIds.length > 0 ? layoutSourcePtyIds : existingSourcePtyIds
        const sourcePrimaryPtyId =
          resolvePrimaryLayoutPtyId(sourceLayout) ?? sourcePtyIds[0] ?? null
        const nextPtyIdsByTabId = {
          ...s.ptyIdsByTabId,
          [sourceTabId]: sourcePtyIds
        }
        if (detachedPtyId) {
          nextPtyIdsByTabId[targetTabId] = uniquePtyIds([
            ...(nextPtyIdsByTabId[targetTabId] ?? []),
            detachedPtyId
          ])
        }
        const nextLastKnownRelayPtyIdByTabId = { ...s.lastKnownRelayPtyIdByTabId }
        if (sourcePrimaryPtyId) {
          nextLastKnownRelayPtyIdByTabId[sourceTabId] = sourcePrimaryPtyId
        } else {
          delete nextLastKnownRelayPtyIdByTabId[sourceTabId]
        }
        if (detachedPtyId) {
          nextLastKnownRelayPtyIdByTabId[targetTabId] = detachedPtyId
        }
        // Why: pane-to-tab detach moves a live PTY without spawning or exiting, so transfer identity without activity bumps.
        const sourceTabsByWorktree = withTerminalTabPtyId(
          s.tabsByWorktree,
          sourceTabId,
          sourcePrimaryPtyId
        )
        const nextTabsByWorktree = detachedPtyId
          ? withTerminalTabPtyId(sourceTabsByWorktree, targetTabId, detachedPtyId)
          : sourceTabsByWorktree
        const directSshLedger = transferDirectSshPaneDetachLedger(s, {
          detachedPtyId,
          sourcePtyId: sourcePrimaryPtyId,
          sourceTabId,
          targetTabId,
          isAuthorityCurrent: (authority) => isCurrentDirectSshAuthority(s, authority)
        })
        return {
          ptyIdsByTabId: nextPtyIdsByTabId,
          lastKnownRelayPtyIdByTabId: nextLastKnownRelayPtyIdByTabId,
          ...directSshLedger,
          ...(nextTabsByWorktree !== s.tabsByWorktree ? { tabsByWorktree: nextTabsByWorktree } : {})
        }
      })
      // Why: detach keeps the process and its pane key alive, so move resume/status authority to the new surface before the source closes.
      get().transferAgentPaneAuthority({
        fromPaneKey: sourcePaneKey,
        toPaneKey: targetPaneKey,
        ptyId: detachedPtyId
      })
    }
  }
}
