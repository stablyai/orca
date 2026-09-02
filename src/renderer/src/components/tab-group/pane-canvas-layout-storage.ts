import {
  createPaneCanvasWorkspaceState,
  reconcilePaneCanvasWorkspaceState,
  type PaneCanvasReconcileOptions,
  type PaneCanvasWorkspaceState
} from './pane-canvas-layout-state'

const PANE_CANVAS_STORAGE_PREFIX = 'orca:pane-canvas:v2:'

export function paneCanvasStorageKey(ownerKey: string): string {
  return `${PANE_CANVAS_STORAGE_PREFIX}${encodeURIComponent(ownerKey)}`
}

export function readPaneCanvasWorkspaceState(
  storage: Pick<Storage, 'getItem'>,
  ownerKey: string,
  terminalTabIds: readonly string[],
  options: PaneCanvasReconcileOptions = {}
): PaneCanvasWorkspaceState {
  const fallback = createPaneCanvasWorkspaceState(terminalTabIds)
  try {
    const raw = storage.getItem(paneCanvasStorageKey(ownerKey))
    if (!raw) {
      return fallback
    }
    const parsed = JSON.parse(raw) as Partial<PaneCanvasWorkspaceState>
    const state: PaneCanvasWorkspaceState = {
      mode: parsed.mode === 'canvas' ? 'canvas' : 'split',
      boundsByTerminalTabId:
        parsed.boundsByTerminalTabId && typeof parsed.boundsByTerminalTabId === 'object'
          ? parsed.boundsByTerminalTabId
          : {}
    }
    return reconcilePaneCanvasWorkspaceState(state, terminalTabIds, undefined, options)
  } catch {
    return fallback
  }
}

export function writePaneCanvasWorkspaceState(
  storage: Pick<Storage, 'setItem'>,
  ownerKey: string,
  state: PaneCanvasWorkspaceState
): void {
  try {
    storage.setItem(paneCanvasStorageKey(ownerKey), JSON.stringify(state))
  } catch {
    // Why: blocked local storage should leave Canvas usable for the current session.
  }
}
