import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { TerminalSlice, TerminalStoreGet, TerminalStoreSet } from './terminal-state'

function withoutValue(record: Record<string, string>, key: string, value: string) {
  if (record[key] !== value) {
    return record
  }
  const next = { ...record }
  delete next[key]
  return next
}

export function createTerminalMoveIntoTabActions(
  set: TerminalStoreSet,
  get: TerminalStoreGet
): Pick<TerminalSlice, 'syncPaneMoveIntoTabPtyOwnership'> {
  return {
    syncPaneMoveIntoTabPtyOwnership: ({ movedLeafId, movedPtyId, sourceTabId, targetTabId }) => {
      set((s) => {
        const sourceScrollback = s.localOnlyScrollbackByTabId[sourceTabId]?.[movedLeafId]
        const sourceUnread = s.unreadTerminalTabs[sourceTabId]
        const { [sourceTabId]: sourceBuffers, ...otherScrollback } = s.localOnlyScrollbackByTabId
        const { [movedLeafId]: _moved, ...sourceBuffersLeft } = sourceBuffers ?? {}
        return {
          // Tab PTY ownership (ptyIdsByTabId, tab rows) is not written here: the renderer
          // layout-writer ratchet counts those writes. The apply step binds the PTY to the target
          // with `updateTabPtyId`, and closeTab(S) drops the source's entries.
          lastKnownRelayPtyIdByTabId: withoutValue(
            s.lastKnownRelayPtyIdByTabId,
            sourceTabId,
            movedPtyId
          ),
          deferredSshSessionIdsByTabId: withoutValue(
            s.deferredSshSessionIdsByTabId,
            sourceTabId,
            movedPtyId
          ),
          pendingReconnectPtyIdByTabId: withoutValue(
            s.pendingReconnectPtyIdByTabId,
            sourceTabId,
            movedPtyId
          ),
          localOnlyScrollbackByTabId: {
            ...otherScrollback,
            ...(Object.keys(sourceBuffersLeft).length > 0
              ? { [sourceTabId]: sourceBuffersLeft }
              : {}),
            ...(sourceScrollback !== undefined
              ? {
                  [targetTabId]: {
                    ...s.localOnlyScrollbackByTabId[targetTabId],
                    [movedLeafId]: sourceScrollback
                  }
                }
              : {})
          },
          unreadTerminalTabs:
            sourceUnread !== undefined && !(targetTabId in s.unreadTerminalTabs)
              ? { ...s.unreadTerminalTabs, [targetTabId]: sourceUnread }
              : s.unreadTerminalTabs
        }
      })
      // Must run before the source closes: its sweep removes every `source:` pane key.
      get().transferAgentPaneAuthority({
        fromPaneKey: makePaneKey(sourceTabId, movedLeafId),
        toPaneKey: makePaneKey(targetTabId, movedLeafId),
        ptyId: movedPtyId
      })
    }
  }
}
