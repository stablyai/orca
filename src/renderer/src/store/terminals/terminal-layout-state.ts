import { editSessionSource } from '@/store/session-source-edits'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { terminalLayoutEqual } from '../../../../shared/terminal-layout-equality'
import {
  normalizeTerminalLayoutPtyOwnership,
  resolveTerminalLayoutPtyOwnershipTransfers
} from '../../../../shared/terminal-layout-pty-ownership'
import type { TerminalSlice, TerminalStoreGet, TerminalStoreSet } from './terminal-state'
import {
  resolvePrimaryLayoutPtyId,
  uniquePtyIds,
  setTerminalTabPtyId
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
            return undefined
          }
          return editSessionSource(s).remove('localOnlyScrollbackByTabId', tabId).finish()
        }
        return editSessionSource(s)
          .set('localOnlyScrollbackByTabId', tabId, buffersByLeafId)
          .finish()
      })
    },
    replaceTerminalLayoutPanePtyId: (tabId, leafId, ptyId) => {
      set((s) => {
        const layout = s.terminalLayoutsByTabId[tabId]
        if (!layout || layout.ptyIdsByLeafId?.[leafId] === ptyId) {
          return undefined
        }
        return editSessionSource(s)
          .set('terminalLayoutsByTabId', tabId, {
            ...layout,
            ptyIdsByLeafId: { ...layout.ptyIdsByLeafId, [leafId]: ptyId }
          })
          .finish({})
      })
    },
    // Why: pane mount/unmount re-asserts the same booleans; bailing like setTabLayout keeps map subscribers asleep.
    setTabPaneExpanded: (tabId, expanded) => {
      set((s) =>
        s.expandedPaneByTabId[tabId] === expanded
          ? undefined
          : { expandedPaneByTabId: { ...s.expandedPaneByTabId, [tabId]: expanded } }
      )
    },
    setTabCanExpandPane: (tabId, canExpand) => {
      set((s) =>
        s.canExpandPaneByTabId[tabId] === canExpand
          ? undefined
          : { canExpandPaneByTabId: { ...s.canExpandPaneByTabId, [tabId]: canExpand } }
      )
    },
    setTabLayout: (tabId, layout) => {
      let ownershipTransfers: ReturnType<typeof resolveTerminalLayoutPtyOwnershipTransfers> = []
      const before = ORCA_LAYOUT_OWNER_IS_MAIN ? get().terminalLayoutsByTabId[tabId] : undefined
      set((s) => {
        if (!layout) {
          if (!(tabId in s.terminalLayoutsByTabId)) {
            return undefined
          }
          return editSessionSource(s).remove('terminalLayoutsByTabId', tabId).finish()
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
          return undefined
        }
        return editSessionSource(s)
          .set('terminalLayoutsByTabId', tabId, normalized.snapshot)
          .finish({})
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
        const edit = editSessionSource(s)
        const layoutSourcePtyIds = uniquePtyIds(Object.values(sourceLayout.ptyIdsByLeafId ?? {}))
        const existingSourcePtyIds = (s.ptyIdsByTabId[sourceTabId] ?? []).filter(
          (ptyId) => ptyId !== detachedPtyId
        )
        const sourcePtyIds =
          layoutSourcePtyIds.length > 0 ? layoutSourcePtyIds : existingSourcePtyIds
        const sourcePrimaryPtyId =
          resolvePrimaryLayoutPtyId(sourceLayout) ?? sourcePtyIds[0] ?? null
        edit.set('ptyIdsByTabId', sourceTabId, sourcePtyIds)
        if (detachedPtyId) {
          edit.set(
            'ptyIdsByTabId',
            targetTabId,
            uniquePtyIds([...(edit.read('ptyIdsByTabId')[targetTabId] ?? []), detachedPtyId])
          )
        }
        if (sourcePrimaryPtyId) {
          edit.set('lastKnownRelayPtyIdByTabId', sourceTabId, sourcePrimaryPtyId)
        } else {
          edit.remove('lastKnownRelayPtyIdByTabId', sourceTabId)
        }
        if (detachedPtyId) {
          edit.set('lastKnownRelayPtyIdByTabId', targetTabId, detachedPtyId)
        }
        // Why: pane-to-tab detach moves a live PTY without spawning or exiting, so transfer identity without activity bumps.
        setTerminalTabPtyId(edit, sourceTabId, sourcePrimaryPtyId)
        if (detachedPtyId) {
          setTerminalTabPtyId(edit, targetTabId, detachedPtyId)
        }
        return edit.finish()
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
