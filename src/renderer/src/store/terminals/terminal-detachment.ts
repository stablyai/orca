import { MAX_DETACHED_TERMINAL_TITLE_LENGTH } from '../../../../shared/detached-terminal-limits'
import { isRemoteExecutionHostPtyId } from '../../../../shared/remote-execution-host-pty-id'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/terminal-tab-types'
import { collectLeafIdsInOrder } from '@/components/terminal-pane/terminal-layout-leaf-ids'
import type { AppState } from '../types'
import type { TerminalStoreGet, TerminalStoreSet } from './terminal-state'
import { resolvePrimaryLayoutPtyId } from './terminal-pty-identities'

export type TerminalDetachTarget = {
  ptyId: string | null
  remoteUnsupported: boolean
  splitUnsupported: boolean
  title: string
}

function countLayoutLeaves(layout: TerminalLayoutSnapshot | undefined): number {
  if (!layout) {
    return 1
  }
  if (layout.root) {
    return collectLeafIdsInOrder(layout.root).length
  }
  return Math.max(1, Object.keys(layout.ptyIdsByLeafId ?? {}).length)
}

export function resolveTerminalDetachTarget(
  state: Pick<AppState, 'tabsByWorktree' | 'terminalLayoutsByTabId'>,
  tabId: string
): TerminalDetachTarget | null {
  const tab = Object.values(state.tabsByWorktree)
    .flat()
    .find((candidate) => candidate.id === tabId)
  return tab ? resolveTabDetachTarget(tab, state.terminalLayoutsByTabId[tabId]) : null
}

/** Reads only the tab and its layout, so a tab-bar row need not scan every worktree's tabs. */
export function resolveTabDetachTarget(
  tab: Pick<TerminalTab, 'ptyId' | 'customTitle' | 'title'>,
  layout: TerminalLayoutSnapshot | undefined
): TerminalDetachTarget {
  const ptyId = (layout ? resolvePrimaryLayoutPtyId(layout) : null) ?? tab.ptyId
  return {
    ptyId,
    remoteUnsupported: ptyId ? isRemoteExecutionHostPtyId(ptyId) : false,
    splitUnsupported: countLayoutLeaves(layout) > 1,
    title: ((tab.customTitle ?? tab.title) || 'Terminal').slice(
      0,
      MAX_DETACHED_TERMINAL_TITLE_LENGTH
    )
  }
}

const pendingOpenTokenByTabId = new Map<string, number>()
let nextOpenToken = 0

function withoutTab(
  detachedTerminalByTabId: AppState['detachedTerminalByTabId'],
  tabId: string
): AppState['detachedTerminalByTabId'] {
  if (!(tabId in detachedTerminalByTabId)) {
    return detachedTerminalByTabId
  }
  const next = { ...detachedTerminalByTabId }
  delete next[tabId]
  return next
}

export function createTerminalDetachmentActions(set: TerminalStoreSet, get: TerminalStoreGet) {
  return {
    detachTerminalTab: async (tabId: string): Promise<boolean> => {
      const target = resolveTerminalDetachTarget(get(), tabId)
      const ptyId = target?.ptyId
      if (!target || !ptyId || target.remoteUnsupported || target.splitUnsupported) {
        return false
      }
      const openToken = ++nextOpenToken
      pendingOpenTokenByTabId.set(tabId, openToken)
      try {
        const opened = await window.api.detachedTerminal.open({
          tabId,
          ptyId,
          title: target.title
        })
        if (!opened) {
          return false
        }
        // Why: re-docked while opening leaves a companion window unless a newer open superseded this one.
        if (pendingOpenTokenByTabId.get(tabId) !== openToken) {
          if (!pendingOpenTokenByTabId.has(tabId)) {
            void window.api.detachedTerminal.close(tabId)
          }
          return false
        }
        // Why: tab may have closed, split, or replaced its PTY while the companion window was opening.
        const currentTarget = resolveTerminalDetachTarget(get(), tabId)
        if (!currentTarget || currentTarget.ptyId !== ptyId || currentTarget.splitUnsupported) {
          void window.api.detachedTerminal.close(tabId)
          return false
        }
        set((state) => ({
          detachedTerminalByTabId: {
            ...state.detachedTerminalByTabId,
            [tabId]: { ptyId }
          }
        }))
        return true
      } finally {
        if (pendingOpenTokenByTabId.get(tabId) === openToken) {
          pendingOpenTokenByTabId.delete(tabId)
        }
      }
    },
    redockDetachedTerminalTab: (tabId: string): void => {
      pendingOpenTokenByTabId.delete(tabId)
      set((state) => ({
        detachedTerminalByTabId: withoutTab(state.detachedTerminalByTabId, tabId)
      }))
    },
    closeDetachedTerminalWindow: (tabId: string): void => {
      if (!(tabId in get().detachedTerminalByTabId)) {
        return
      }
      void window.api.detachedTerminal.close(tabId)
      set((state) => ({
        detachedTerminalByTabId: withoutTab(state.detachedTerminalByTabId, tabId)
      }))
    },
    focusDetachedTerminalWindow: (tabId: string): void => {
      const target = resolveTerminalDetachTarget(get(), tabId)
      if (tabId in get().detachedTerminalByTabId && target?.ptyId) {
        void window.api.detachedTerminal.open({ tabId, ptyId: target.ptyId, title: target.title })
      }
    }
  }
}
