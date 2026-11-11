import { terminalStartsAfterLayout } from './retained-terminal-start-lifecycle'
import { replaceRecordEntries } from '@/store/keyed-record-transitions'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import { terminalLayoutEqual } from '../../../../shared/workspace-layout/terminal-layout-equality'
import {
  normalizeTerminalLayoutPtyOwnership,
  resolveTerminalLayoutPtyOwnershipTransfers
} from '../../../../shared/workspace-layout/terminal-layout-pty-ownership'
import type { TerminalSlice, TerminalStoreGet, TerminalStoreSet } from './terminal-state'
import {
  resolvePrimaryLayoutPtyId,
  uniquePtyIds,
  withTerminalTabPtyIds
} from './terminal-pty-identities'
import { transferNormalizedTerminalLayoutPtyOwnership } from './workspace-terminal-hydration-patch'
import { recordChatPaneInLayoutOwner } from './terminal-chat-pane-layout-owner'

export function createTerminalLayoutActions(
  set: TerminalStoreSet,
  get: TerminalStoreGet
): Pick<
  TerminalSlice,
  | 'replaceTerminalLayoutPanePtyId'
  | 'setTabPaneExpanded'
  | 'setTabCanExpandPane'
  | 'setTabLayout'
  | 'setTabLocalOnlyScrollback'
  | 'syncPaneDetachPtyOwnership'
> {
  return {
    // Ordinary-park scrollback stays local, outside remote projection; resolveLeafScrollbackBuffers reads WorkspaceSessionState.localOnlyScrollbackByTabId.
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
        if (!layout) {
          return s
        }
        const settledUnknown = s.terminalStartupAttempt?.acceptBinding(tabId, leafId) === true
        const nextLayout = {
          ...layout,
          ptyIdsByLeafId: { ...layout.ptyIdsByLeafId, [leafId]: ptyId }
        }
        const starts = terminalStartsAfterLayout(
          s.terminalPaneStartsByPaneKey,
          tabId,
          layout,
          nextLayout,
          leafId
        )
        if (layout.ptyIdsByLeafId?.[leafId] === ptyId) {
          return starts !== s.terminalPaneStartsByPaneKey || settledUnknown
            ? {
                terminalPaneStartsByPaneKey: starts,
                terminalStartupAttempt: s.terminalStartupAttempt
              }
            : s
        }
        return {
          terminalPaneStartsByPaneKey: starts,
          terminalLayoutsByTabId: replaceRecordEntries<
            TerminalSlice['terminalLayoutsByTabId'][string]
          >(s.terminalLayoutsByTabId, [[tabId, nextLayout]])
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
    setTabLayout: (tabId, layout, acceptedLeafId) => {
      let ownershipTransfers: ReturnType<typeof resolveTerminalLayoutPtyOwnershipTransfers> = []
      const before = ORCA_LAYOUT_OWNER_IS_MAIN ? get().terminalLayoutsByTabId[tabId] : undefined
      set((s) => {
        if (!layout) {
          if (!(tabId in s.terminalLayoutsByTabId)) {
            return s
          }
          s.terminalStartupAttempt?.layoutChanged(tabId, s.terminalLayoutsByTabId[tabId], null)
          return {
            terminalPaneStartsByPaneKey: terminalStartsAfterLayout(
              s.terminalPaneStartsByPaneKey,
              tabId,
              s.terminalLayoutsByTabId[tabId],
              null
            ),
            terminalLayoutsByTabId: replaceRecordEntries<
              TerminalSlice['terminalLayoutsByTabId'][string]
            >(s.terminalLayoutsByTabId, [[tabId, null]])
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
        const settledUnknown =
          acceptedLeafId && normalized.snapshot.ptyIdsByLeafId?.[acceptedLeafId]
            ? s.terminalStartupAttempt?.acceptBinding(tabId, acceptedLeafId) === true
            : false
        const starts = terminalStartsAfterLayout(
          s.terminalPaneStartsByPaneKey,
          tabId,
          existing,
          normalized.snapshot,
          acceptedLeafId
        )
        if (existing && terminalLayoutEqual(existing, normalized.snapshot)) {
          return starts !== s.terminalPaneStartsByPaneKey || settledUnknown
            ? {
                terminalPaneStartsByPaneKey: starts,
                terminalStartupAttempt: s.terminalStartupAttempt
              }
            : s
        }
        s.terminalStartupAttempt?.layoutChanged(tabId, existing, normalized.snapshot)
        return {
          terminalPaneStartsByPaneKey: starts,
          terminalLayoutsByTabId: replaceRecordEntries<
            TerminalSlice['terminalLayoutsByTabId'][string]
          >(s.terminalLayoutsByTabId, [[tabId, normalized.snapshot]])
        }
      })
      transferNormalizedTerminalLayoutPtyOwnership(get(), tabId, ownershipTransfers)
      // Switch point: the chat pane the window picks reaches main as a command, not by its save.
      if (ORCA_LAYOUT_OWNER_IS_MAIN && layout) {
        recordChatPaneInLayoutOwner(get(), tabId, before, get().terminalLayoutsByTabId[tabId])
      }
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
        const ptyReplacements: [string, string[]][] = [[sourceTabId, sourcePtyIds]]
        if (detachedPtyId) {
          ptyReplacements.push([
            targetTabId,
            uniquePtyIds([
              ...(targetTabId === sourceTabId
                ? sourcePtyIds
                : (s.ptyIdsByTabId[targetTabId] ?? [])),
              detachedPtyId
            ])
          ])
        }
        const relayReplacements: [string, string | null][] = [
          [sourceTabId, sourcePrimaryPtyId || null]
        ]
        if (detachedPtyId) {
          relayReplacements.push([targetTabId, detachedPtyId])
        }
        // Why: pane-to-tab detach moves a live PTY without spawning or exiting, so transfer identity without activity bumps.
        const nextTabsByWorktree = withTerminalTabPtyIds(s.tabsByWorktree, [
          { tabId: sourceTabId, ptyId: sourcePrimaryPtyId },
          ...(detachedPtyId ? [{ tabId: targetTabId, ptyId: detachedPtyId }] : [])
        ])
        return {
          ptyIdsByTabId: replaceRecordEntries(s.ptyIdsByTabId, ptyReplacements),
          lastKnownRelayPtyIdByTabId: replaceRecordEntries(
            s.lastKnownRelayPtyIdByTabId,
            relayReplacements
          ),
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
