import {
  isTerminalLeafId,
  parsePaneKey,
  type TerminalLeafId
} from '../../../../shared/stable-pane-id'
import type { ManagedPane } from './pane-manager-types'

export type PaneKeyUnresolvedReason = 'confirmed-missing' | 'ownership-mismatch' | 'invalid'

export type PaneKeyResolution =
  | {
      status: 'resolved'
      paneKey: string
      leafId: TerminalLeafId
      numericPaneId: number
    }
  | {
      status: 'unresolved'
      paneKey: string | null
      leafId: TerminalLeafId | null
      reason: PaneKeyUnresolvedReason
    }

export type PaneKeyResolutionManager = {
  getNumericIdForLeaf(leafId: string): number | null
  getPanes(): ManagedPane[]
}

export function resolvePaneKeyForManager(
  tabId: string,
  paneKey: string,
  manager: PaneKeyResolutionManager | null
): PaneKeyResolution {
  const parsed = parsePaneKey(paneKey)
  if (!parsed || parsed.tabId !== tabId) {
    return { status: 'unresolved', paneKey, leafId: parsed?.leafId ?? null, reason: 'invalid' }
  }
  return resolveLeafIdForManager(tabId, parsed.leafId, manager, paneKey)
}

export function resolveLeafIdForManager(
  tabId: string,
  leafId: string,
  manager: PaneKeyResolutionManager | null,
  paneKey: string | null = null
): PaneKeyResolution {
  if (!isTerminalLeafId(leafId)) {
    return { status: 'unresolved', paneKey, leafId: null, reason: 'invalid' }
  }
  if (!manager) {
    return { status: 'unresolved', paneKey, leafId, reason: 'confirmed-missing' }
  }

  const numericPaneId = manager.getNumericIdForLeaf(leafId)
  if (numericPaneId === null) {
    return { status: 'unresolved', paneKey, leafId, reason: 'confirmed-missing' }
  }

  const pane = manager.getPanes().find((candidate) => candidate.id === numericPaneId)
  if (!pane) {
    return { status: 'unresolved', paneKey, leafId, reason: 'confirmed-missing' }
  }
  if (pane.leafId !== leafId) {
    // Why: numeric pane ids can be reused after replay/teardown. The stable
    // leaf must still match at the moment the caller needs a live handle.
    return { status: 'unresolved', paneKey, leafId, reason: 'ownership-mismatch' }
  }

  return { status: 'resolved', paneKey: paneKey ?? `${tabId}:${leafId}`, leafId, numericPaneId }
}
