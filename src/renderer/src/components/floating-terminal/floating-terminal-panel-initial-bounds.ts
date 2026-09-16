import {
  getDefaultFloatingTerminalBounds,
  getDefaultFloatingTerminalCommittedBounds,
  getMaximizedFloatingTerminalBounds,
  readPersistedFloatingTerminalPanelBounds,
  resolveFloatingTerminalPanelBounds,
  resolveFloatingTerminalPanelCommittedBounds,
  shouldReconcileFloatingTerminalPanelBounds,
  type FloatingTerminalPanelBounds,
  type FloatingTerminalPanelBoundsSource,
  type FloatingTerminalPanelCommittedBounds
} from './floating-terminal-panel-bounds'
import { shouldRestoreMaximizedPanelBounds } from './floating-terminal-panel-restore-geometry'
import { readPersistedFloatingTerminalPanelViewState } from './floating-terminal-panel-view-state'

export type FloatingTerminalPanelBoundsState = {
  committedBounds: FloatingTerminalPanelCommittedBounds
  renderedBounds: FloatingTerminalPanelBounds
  source: FloatingTerminalPanelBoundsSource
}

export function readInitialPanelBounds(): FloatingTerminalPanelBoundsState {
  const defaultCommittedBounds = getDefaultFloatingTerminalCommittedBounds()
  const defaultRenderedBounds = getDefaultFloatingTerminalBounds()
  const persistedBounds = readPersistedFloatingTerminalPanelBounds()
  if (shouldRestoreMaximizedPanelBounds(readPersistedFloatingTerminalPanelViewState())) {
    // Keep committed bounds as the restore target while maximizing the first paint.
    return {
      committedBounds: persistedBounds ?? defaultCommittedBounds,
      renderedBounds: getMaximizedFloatingTerminalBounds(),
      source: persistedBounds ? 'user' : 'default'
    }
  }
  return persistedBounds
    ? {
        committedBounds: persistedBounds,
        renderedBounds: shouldReconcileFloatingTerminalPanelBounds('user')
          ? resolveFloatingTerminalPanelBounds(persistedBounds, 'user')
          : resolveFloatingTerminalPanelCommittedBounds(persistedBounds),
        source: 'user'
      }
    : {
        committedBounds: defaultCommittedBounds,
        renderedBounds: defaultRenderedBounds,
        source: 'default'
      }
}

export function areFloatingTerminalPanelCommittedBoundsEqual(
  left: FloatingTerminalPanelCommittedBounds | null,
  right: FloatingTerminalPanelCommittedBounds
): boolean {
  return left !== null && JSON.stringify(left) === JSON.stringify(right)
}
