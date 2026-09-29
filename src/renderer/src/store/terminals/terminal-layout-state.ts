import { makePaneKey } from '../../../../shared/stable-pane-id'
import { terminalLayoutEqual, terminalLayoutNodeEqual } from '@/lib/terminal-layout-equality'
import { getConnectionIdFromState } from '@/lib/connection-owner-resolution'
import { omitRecordKeys } from '../slices/worktrees/teardown/record-key-omission'
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

export function createTerminalLayoutActions(
  set: TerminalStoreSet,
  get: TerminalStoreGet
): Pick<
  TerminalSlice,
  | 'replaceTerminalLayoutPanePtyId'
  | 'setTabPaneExpanded'
  | 'setTabCanExpandPane'
  | 'setTabLayout'
  | 'acknowledgeDirectSshLayoutEdits'
  | 'setTabLocalOnlyScrollback'
  | 'syncPaneDetachPtyOwnership'
> {
  return {
    // Why separate from setTabLayout: ordinary-park scrollback must not ride the remote projection.
    // See WorkspaceSessionState.localOnlyScrollbackByTabId; read via resolveLeafScrollbackBuffers.
    setTabLocalOnlyScrollback: (tabId, buffersByLeafId) => {
      set((s) => {
        const current = s.localOnlyScrollbackByTabId ?? {}
        if (!buffersByLeafId || Object.keys(buffersByLeafId).length === 0) {
          if (!(tabId in current)) {
            return s
          }
          const next = { ...current }
          delete next[tabId]
          return { localOnlyScrollbackByTabId: next }
        }
        return { localOnlyScrollbackByTabId: { ...current, [tabId]: buffersByLeafId } }
      })
    },
    replaceTerminalLayoutPanePtyId: (tabId, leafId, ptyId) => {
      set((s) => {
        const layout = s.terminalLayoutsByTabId[tabId]
        if (!layout || layout.ptyIdsByLeafId?.[leafId] === ptyId) {
          return s
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
    // Why: pane mount/unmount re-asserts the same booleans; bailing like setTabLayout keeps map subscribers asleep.
    setTabPaneExpanded: (tabId, expanded) => {
      set((s) =>
        s.expandedPaneByTabId[tabId] === expanded
          ? s
          : { expandedPaneByTabId: { ...s.expandedPaneByTabId, [tabId]: expanded } }
      )
    },
    setTabCanExpandPane: (tabId, canExpand) => {
      set((s) =>
        s.canExpandPaneByTabId[tabId] === canExpand
          ? s
          : { canExpandPaneByTabId: { ...s.canExpandPaneByTabId, [tabId]: canExpand } }
      )
    },
    acknowledgeDirectSshLayoutEdits: (uploaded) => {
      set((s) => {
        const acknowledged = Object.keys(uploaded).filter((tabId) => {
          const pending = s.pendingDirectSshLayoutEditsByTabId[tabId]
          const candidate = uploaded[tabId]
          return pending === candidate
        })
        const pending = omitRecordKeys(s.pendingDirectSshLayoutEditsByTabId, acknowledged)
        return pending === s.pendingDirectSshLayoutEditsByTabId
          ? s
          : { pendingDirectSshLayoutEditsByTabId: pending }
      })
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
          return {
            terminalLayoutsByTabId: next,
            pendingDirectSshLayoutEditsByTabId: omitRecordKeys(
              s.pendingDirectSshLayoutEditsByTabId,
              [tabId]
            )
          }
        }
        const normalized = normalizeTerminalLayoutPtyOwnership(layout)
        // Resolved before the bailout: normalization can transfer pane ownership even when the stored snapshot is untouched.
        if (normalized.changed) {
          ownershipTransfers = resolveTerminalLayoutPtyOwnershipTransfers(
            layout,
            normalized.snapshot
          )
        }
        // Why: pane-title churn re-persists structurally identical snapshots; bailing keeps every pane selector asleep.
        const existing = s.terminalLayoutsByTabId[tabId]
        if (existing && terminalLayoutEqual(existing, normalized.snapshot)) {
          return s
        }
        const structuralEdit = !terminalLayoutNodeEqual(existing?.root, normalized.snapshot.root)
        const workspaceId = structuralEdit
          ? Object.keys(s.tabsByWorktree).find((id) =>
              s.tabsByWorktree[id].some((tab) => tab.id === tabId)
            )
          : undefined
        const tracksRemoteEdit = workspaceId && getConnectionIdFromState(s, workspaceId)
        return {
          terminalLayoutsByTabId: { ...s.terminalLayoutsByTabId, [tabId]: normalized.snapshot },
          ...(tracksRemoteEdit
            ? {
                pendingDirectSshLayoutEditsByTabId: {
                  ...s.pendingDirectSshLayoutEditsByTabId,
                  [tabId]: { targetId: tracksRemoteEdit, root: normalized.snapshot.root }
                }
              }
            : {})
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
